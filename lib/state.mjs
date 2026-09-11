// Live model of cmux: workspaces/groups/panes/surfaces (polled, event-debounced),
// per-workspace status lanes, workspace ↔ Claude-session mapping (from hook
// events), and actionable feed items (permissions/questions awaiting the user).

import { EventEmitter } from 'node:events';
import { rpc, watchEvents } from './cmux.mjs';

const WORKING_STALE_MS = 10 * 60 * 1000; // working with no activity → idle
const REFRESH_DEBOUNCE_MS = 400;
const FALLBACK_POLL_MS = 30_000;

// Feed items that still need a human. Everything else is telemetry/history.
const NON_ACTIONABLE_STATUS = new Set([
  'telemetry', 'completed', 'answered', 'dismissed', 'expired', 'replied', 'canceled', 'cancelled',
]);
const ACTIONABLE_KINDS = new Set(['permission', 'question', 'exitPlan', 'exit_plan', 'plan', 'notification']);

const ATTENTION_RE = /needs your input|needs input|permission|waiting for|approve|question/i;
const ERROR_RE = /error|failed|failure|crash/i;
const DONE_RE = /finished|done|complete/i;

export class CmuxState extends EventEmitter {
  constructor(cursorFile, log = console.error) {
    super();
    this.log = log;
    this.workspaces = [];
    this.groups = [];
    this.panesByWs = new Map(); // ws id -> [{id, ref, focused, surfaces: [...]}]
    this.lanes = new Map(); // ws id -> {lane, detail, ts}
    this.sessions = new Map(); // ws id -> {sessionId, cwd, surfaceId, ts}
    this.sessionsBySurface = new Map(); // surface id -> {sessionId, cwd, ts} (multi-agent workspaces)
    this.pending = new Map(); // ws id -> [feed items]
    this.online = false;
    this._refreshTimer = null;

    this.stopEvents = watchEvents(cursorFile, (e) => this._onEvent(e), (msg) => this.log(`[events] ${msg}`));
    this.refresh().catch((err) => this.log(`initial refresh: ${err.message}`));
    this._poller = setInterval(() => {
      this.refresh().catch((err) => this.log(`poll refresh: ${err.message}`));
    }, FALLBACK_POLL_MS);
  }

  close() {
    this.stopEvents();
    clearInterval(this._poller);
  }

  _setLane(wsId, lane, detail) {
    if (!wsId) return;
    this.lanes.set(wsId, { lane, detail: String(detail || '').slice(0, 140), ts: Date.now() });
    this._emitSoon();
  }

  _onEvent(e) {
    const ws = e.workspace_id;
    const name = e.name || '';
    const p = e.payload || {};

    if (name.startsWith('agent.hook.')) {
      // Hook events carry the ws ↔ session mapping for the Chat tab.
      if (p.session_id && ws) {
        const entry = {
          sessionId: String(p.session_id),
          cwd: p.cwd || null,
          surfaceId: e.surface_id || p.surface_id || null,
          ts: Date.now(),
        };
        this.sessions.set(ws, entry);
        if (entry.surfaceId) this.sessionsBySurface.set(entry.surfaceId, entry);
      }
      const hook = name.slice('agent.hook.'.length);
      if (hook === 'Stop' || hook === 'SubagentStop') {
        this._setLane(ws, 'done', 'finished');
      } else if (hook === 'Notification') {
        const text = `${p.title || ''} ${p.message || p.body || ''}`;
        this._setLane(ws, ATTENTION_RE.test(text) || !text.trim() ? 'attention' : 'working', text.trim() || 'needs attention');
      } else if (hook === 'UserPromptSubmit' || hook === 'PreToolUse' || hook === 'PostToolUse') {
        this._setLane(ws, 'working', p.tool_name || 'thinking');
      }
      this.emit('activity', { workspaceId: ws });
      return;
    }

    switch (name) {
      case 'notification.created':
      case 'notification.requested': {
        const text = `${p.title || ''} ${p.subtitle || ''} ${p.body || ''}`.trim();
        if (ERROR_RE.test(text)) this._setLane(ws, 'attention', text);
        else if (ATTENTION_RE.test(text)) this._setLane(ws, 'attention', text);
        else if (DONE_RE.test(text)) this._setLane(ws, 'done', text);
        this._emitSoon();
        break;
      }
      case 'workspace.prompt.submitted':
      case 'surface.input_sent':
      case 'surface.key_sent':
        this._setLane(ws, 'working', 'processing input');
        break;
      case 'feed.item.received':
      case 'feed.item.completed':
        this._refreshPending();
        break;
      default:
        if (name.startsWith('workspace.') || name.startsWith('surface.') || name.startsWith('sidebar.')) {
          this._scheduleRefresh();
        }
    }
  }

  _scheduleRefresh() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refresh().catch((err) => this.log(`refresh: ${err.message}`));
    }, REFRESH_DEBOUNCE_MS);
  }

  async refresh() {
    const [wsList, groupList, tree] = await Promise.all([
      rpc('workspace.list'),
      rpc('workspace.group.list').catch(() => ({ groups: [] })),
      rpc('system.tree'),
    ]);
    this.workspaces = wsList.workspaces || [];
    this.groups = groupList.groups || [];

    this.panesByWs = new Map();
    for (const win of tree.windows || []) {
      for (const ws of win.workspaces || []) {
        this.panesByWs.set(ws.id, (ws.panes || []).map((pane) => ({
          id: pane.id,
          ref: pane.ref,
          focused: !!pane.focused,
          surfaces: (pane.surfaces || []).map((s) => ({
            id: s.id,
            ref: s.ref,
            type: s.surface_type || s.type || 'terminal',
            title: s.title || '',
            focused: !!s.focused,
            selected: s.id === pane.selected_surface_id,
          })),
        })));
      }
    }
    this.online = true;
    await this._refreshPending();
    this._emitSoon();
  }

  async _refreshPending() {
    try {
      const feed = await rpc('feed.list');
      const byWs = new Map();
      for (const item of feed.items || []) {
        const status = String(item.status || '').toLowerCase();
        const kind = String(item.kind || '');
        const actionable = !NON_ACTIONABLE_STATUS.has(status) && (ACTIONABLE_KINDS.has(kind) || /pending|waiting|open/.test(status));
        if (!actionable) continue;
        const wsId = this._workspaceForFeedItem(item);
        if (!wsId) continue;
        if (!byWs.has(wsId)) byWs.set(wsId, []);
        byWs.get(wsId).push({
          id: item.id,
          kind,
          status,
          title: item.title || kind,
          body: item.body || item.question || item.message || '',
          options: item.options || item.choices || null,
          createdAt: item.created_at,
        });
      }
      this.pending = byWs;
      this._emitSoon();
    } catch (err) {
      this.log(`feed.list: ${err.message}`);
    }
  }

  _workspaceForFeedItem(item) {
    const stream = String(item.workstream_id || '');
    for (const [wsId, s] of this.sessions) {
      if (stream.includes(s.sessionId) || s.sessionId.includes(stream.replace(/^claude-/, ''))) return wsId;
    }
    if (item.cwd) {
      const match = this.workspaces.find((w) => w.current_directory === item.cwd);
      if (match) return match.id;
    }
    return null;
  }

  laneFor(wsId) {
    const pendingItems = this.pending.get(wsId) || [];
    if (pendingItems.length) {
      return { lane: 'attention', detail: pendingItems[0].title, ts: Date.now() };
    }
    const stored = this.lanes.get(wsId);
    if (!stored) return { lane: 'idle', detail: '', ts: 0 };
    if (stored.lane === 'working' && Date.now() - stored.ts > WORKING_STALE_MS) {
      return { ...stored, lane: 'idle' };
    }
    return stored;
  }

  // The surface the Claude agent runs in — Chat tab binds here.
  agentSurface(wsId) {
    const session = this.sessions.get(wsId);
    const panes = this.panesByWs.get(wsId) || [];
    const surfaces = panes.flatMap((p) => p.surfaces);
    if (session?.surfaceId && surfaces.some((s) => s.id === session.surfaceId)) return session.surfaceId;
    const focusedTerm = surfaces.find((s) => s.type === 'terminal' && (s.focused || s.selected));
    return (focusedTerm || surfaces.find((s) => s.type === 'terminal') || surfaces[0])?.id || null;
  }

  snapshot() {
    return {
      online: this.online,
      generatedAt: Date.now(),
      groups: this.groups.map((g) => ({
        id: g.id,
        title: g.title || g.name || 'group',
        workspaceIds: g.workspace_ids || g.workspaceIds || (g.workspaces || []).map((w) => w.id ?? w),
        collapsed: !!g.collapsed,
      })),
      workspaces: this.workspaces.map((w) => {
        const { lane, detail, ts } = this.laneFor(w.id);
        return {
          id: w.id,
          ref: w.ref,
          index: w.index,
          title: w.title || w.ref,
          cwd: w.current_directory,
          selected: !!w.selected,
          lastMessage: w.latest_conversation_message || w.latest_submitted_message || '',
          lastSubmittedAt: w.latest_submitted_at || null,
          lane,
          laneDetail: detail,
          laneTs: ts,
          pending: this.pending.get(w.id) || [],
          agentSurfaceId: this.agentSurface(w.id),
          surfaces: (this.panesByWs.get(w.id) || []).flatMap((p) => p.surfaces)
            .map((s) => ({ ...s, hasSession: this.sessionsBySurface.has(s.id) })),
          session: this.sessions.get(w.id) || null,
        };
      }),
    };
  }

  _emitSoon() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('state', this.snapshot());
    }, 300);
  }
}
