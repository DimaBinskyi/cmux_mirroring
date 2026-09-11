// Reads Claude Code session transcripts (~/.claude/projects/<slug>/<id>.jsonl)
// and flattens them into chat messages for the phone's Chat tab.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_MESSAGES = 150;

function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
}

export function resolveTranscript(sessionId, cwd) {
  const id = String(sessionId).replace(/^claude-/, '');
  if (cwd) {
    const candidate = path.join(PROJECTS_DIR, projectSlug(cwd), `${id}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback: the session id is globally unique — scan project dirs for it.
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const candidate = path.join(PROJECTS_DIR, dir, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* projects dir missing */
  }
  return null;
}

// Newest transcript for a directory — used when no hook event has fired yet.
export function newestTranscriptForCwd(cwd) {
  try {
    const dir = path.join(PROJECTS_DIR, projectSlug(cwd));
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full || null;
  } catch {
    return null;
  }
}

function toolDetail(input = {}) {
  const detail = input.file_path || input.path || input.command || input.description
    || input.prompt || input.pattern || input.url || '';
  return String(detail).replace(/\s+/g, ' ').slice(0, 100);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function parseTranscript(file, limit = MAX_MESSAGES) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { messages: [], mtime: 0 };
  }
  const messages = [];
  const toolResults = new Map(); // tool_use_id -> { isError }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (!msg || entry.isMeta) continue;

    if (entry.type === 'user') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'tool_result') {
            toolResults.set(part.tool_use_id, { isError: !!part.is_error });
          }
        }
      }
      const text = textOf(content).trim();
      // Skip synthetic/system-shaped user entries (skill loads, command output).
      if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) {
        messages.push({ role: 'user', text: text.slice(0, 4000), ts: entry.timestamp });
      }
    } else if (entry.type === 'assistant') {
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (part.type === 'text' && part.text?.trim()) {
          messages.push({ role: 'assistant', text: part.text.slice(0, 6000), ts: entry.timestamp });
        } else if (part.type === 'tool_use') {
          messages.push({
            role: 'tool',
            name: part.name,
            detail: toolDetail(part.input),
            toolUseId: part.id,
            ts: entry.timestamp,
          });
        }
      }
    }
  }

  for (const m of messages) {
    if (m.role === 'tool' && m.toolUseId) {
      const result = toolResults.get(m.toolUseId);
      m.status = result ? (result.isError ? 'error' : 'ok') : 'pending';
      delete m.toolUseId;
    }
  }

  const truncated = messages.length > limit;
  return {
    messages: truncated ? messages.slice(-limit) : messages,
    truncated,
    mtime: fs.statSync(file).mtimeMs,
  };
}
