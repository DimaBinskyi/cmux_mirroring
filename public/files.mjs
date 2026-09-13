// The Mac's files on the phone, read-only. One directory per request (nothing
// walks a tree), text paged a chunk at a time, media handed to the browser as a
// URL so it streams instead of arriving through JSON.
//
// Two instances run: a global one rooted at ~ that keeps its place in the hash,
// and a per-session one that opens at the workspace's cwd and keeps its place
// in memory. Everything below is shared between them — the differences are the
// options passed to createFileBrowser.

const LINES_PAGE = 2000; // lines rendered per tap — a phone chokes well before a file does
const LINE_MAX = 2000; // a minified bundle is one line; render it whole and Safari stops

// Directories nobody opens a file browser to read. Shown, but dimmed, so a
// directory of nothing but node_modules does not look like a wall of equals.
const NOISY = /^(node_modules|\.git|dist|build|out|\.next|\.nuxt|\.venv|venv|__pycache__|\.cache|\.turbo|target|Pods)$/;

const ICON = {
  dir: '📁',
  image: '🖼',
  video: '🎞',
  audio: '🎵',
  pdf: '📕',
};

const EXT_ICON = [
  [/\.(md|txt|rst)$/i, '📝'],
  [/\.(json|ya?ml|toml|ini|conf|plist)$/i, '⚙️'],
  [/\.(zip|gz|tgz|bz2|xz|7z|rar|dmg)$/i, '🗜'],
  [/\.(jsx?|mjs|cjs|tsx?|py|rb|go|rs|java|php|sh|c|h|cpp|swift|kt|sql|css|html?|vue|svelte)$/i, '📜'],
];

export function createFileBrowser({
  api, esc, fmtSize, relTime, fsKey, onLongPress, insertPath, inSession, viewer,
  hashNav = false, onPath = null,
}) {
  let host = null; // the element we paint into
  let cwd = '~';
  let data = null;
  let error = null;
  let filter = '';
  let hidden = false;

  const fileUrl = (p, download) => `/api/fs/file?path=${encodeURIComponent(p)}`
    + `&key=${encodeURIComponent(fsKey())}${download ? '&download=1' : ''}`;

  const kindOf = (name) => (/\.(jpe?g|png|gif|webp|avif|bmp|ico|heic|heif)$/i.test(name) ? 'image'
    : /\.(mp4|m4v|mov|webm)$/i.test(name) ? 'video'
      : /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(name) ? 'audio'
        : /\.pdf$/i.test(name) ? 'pdf' : 'text');

  function icon(e) {
    if (e.dir) return ICON.dir;
    const kind = kindOf(e.name);
    if (kind !== 'text') return ICON[kind];
    return EXT_ICON.find(([re]) => re.test(e.name))?.[1] || '📄';
  }

  // ------------------------------------------------------------------ listing
  function mount(el, startPath) {
    host = el;
    const target = startPath || cwd || '~';
    if (data && (data.path === target || data.display === target)) {
      cwd = target;
      paint();
      return;
    }
    cwd = target;
    data = null;
    error = null;
    filter = '';
    paint();
    load();
  }

  function go(p) {
    if (hashNav) {
      location.hash = `#/files/${encodeURIComponent(p)}`; // hashchange re-mounts us
      return;
    }
    cwd = p;
    data = null;
    error = null;
    filter = '';
    paint();
    load();
  }

  // Set by "Try again": tells the Mac to give a folder it has refused once more
  // chance, which is what you want right after granting it access.
  let retry = false;

  async function load() {
    const want = cwd;
    const again = retry ? '&retry=1' : '';
    retry = false;
    try {
      const d = await api(`/api/fs/list?path=${encodeURIComponent(want)}${hidden ? '&hidden=1' : ''}${again}`);
      if (want !== cwd) return; // navigated away while this was in flight
      data = d;
      error = null;
      onPath?.(d.path);
    } catch (err) {
      if (want !== cwd) return;
      data = null;
      error = err;
    }
    paint();
  }

  // ~/Documents/dev → tappable segments, each with the absolute path behind it.
  function crumbsHtml() {
    const parts = data.display.split('/');
    const home = data.path.slice(0, data.path.length - (data.display.length - 1));
    let acc = home;
    return parts.map((seg, i) => {
      if (i) acc += `/${seg}`;
      const target = i ? acc : home;
      return `${i ? '<span class="sep">/</span>' : ''}<button data-crumb="${esc(target)}">${esc(seg)}</button>`;
    }).join('');
  }

  function paint() {
    if (!host) return;
    if (error) return paintError();
    if (!data) {
      host.innerHTML = '<div class="empty">Reading the Mac…</div>';
      return;
    }
    const q = filter.trim().toLowerCase();
    // The index travels with the row: taps look the entry up by it, and
    // filtering must not shift what a row points at.
    const rows = data.entries.map((e, i) => [e, i]).filter(([e]) => !q || e.name.toLowerCase().includes(q));
    host.innerHTML = `
      <div class="fb-bar">
        ${data.parent ? `<button class="fb-act" data-up="${esc(data.parent)}">↑</button>` : ''}
        <span class="fb-crumb">${crumbsHtml()}</span>
        <button class="fb-act ${hidden ? 'on' : ''}" id="fb-hidden" title="Show dotfiles">•</button>
      </div>
      <input class="fb-filter" id="fb-filter" placeholder="Filter ${data.entries.length} items…"
        value="${esc(filter)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      ${rows.map(([e, i]) => rowHtml(e, i)).join('')
        || '<div class="empty">Nothing here.</div>'}
      ${data.truncated ? `<div class="note">showing the first ${data.entries.length} of ${data.total} — filter to find the rest</div>` : ''}`;

    const f = host.querySelector('#fb-filter');
    f.addEventListener('input', () => {
      filter = f.value;
      const at = f.selectionStart;
      paint();
      const again = host.querySelector('#fb-filter');
      again.focus();
      again.setSelectionRange(at, at);
    });
    host.querySelector('#fb-hidden').onclick = () => {
      hidden = !hidden;
      load();
    };
    for (const b of host.querySelectorAll('[data-crumb]')) b.onclick = () => go(b.dataset.crumb);
    const up = host.querySelector('[data-up]');
    if (up) up.onclick = () => go(up.dataset.up);
    for (const b of host.querySelectorAll('[data-i]')) {
      const e = data.entries[Number(b.dataset.i)];
      const full = `${data.path}/${e.name}`;
      b.onclick = () => {
        if (e.blocked) {
          alert(e.blocked === 'unreadable'
            ? 'Not readable — a broken link, or the Mac will not let us in.'
            : 'Blocked: this one holds credentials, so the phone cannot read it.');
        } else if (e.dir) go(full);
        else openFile(full, e);
      };
      // Hold a row to drop its path into the prompt you were typing.
      if (inSession()) onLongPress(b, () => insertPath(full));
    }
  }

  function rowHtml(e, i) {
    const cls = [e.blocked ? 'blocked' : '', !e.blocked && e.dir && NOISY.test(e.name) ? 'dim' : ''].filter(Boolean).join(' ');
    const meta = e.blocked === 'secret' ? '🔒'
      : e.blocked ? '⚠️'
        : e.dir ? '›' : `${fmtSize(e.size)} · ${relTime(e.mtime)}`;
    return `<button class="fb-row ${cls}" data-i="${i}">
      <span class="fb-ico">${e.blocked === 'secret' ? '🔒' : icon(e)}</span>
      <span class="fb-name">${esc(e.name)}${e.link ? ' <span class="fb-link">↗</span>' : ''}</span>
      <span class="fb-meta">${meta}</span>
    </button>`;
  }

  function paintError() {
    const needsKey = /key required/i.test(error.message);
    host.innerHTML = needsKey
      ? `<div class="card"><div class="cfg-label">Locked</div>
           <div class="muted">Reading the Mac's files needs the file browser key. It is printed in the server log and stored in <code>data/fs-key</code> on the Mac.</div>
           <button class="bigbtn" id="fb-settings">Enter the key in Settings</button></div>`
      : `<div class="empty">${esc(error.message)}</div>
         <button class="bigbtn secondary" id="fb-retry">Try again</button>`;
    const s = host.querySelector('#fb-settings');
    if (s) s.onclick = () => { location.hash = '#/settings'; };
    const r = host.querySelector('#fb-retry');
    if (r) {
      r.onclick = () => {
        error = null;
        retry = true;
        paint();
        load();
      };
    }
  }

  // ------------------------------------------------------------------- viewer
  // One overlay for every kind: text pages in, media is a URL, and anything the
  // browser cannot make sense of shows its first kilobyte as hex.
  let doc = null;

  function closeViewer() {
    viewer.hidden = true;
    viewer.innerHTML = ''; // also stops a playing video
    doc = null;
  }

  async function openFile(full, entry) {
    viewer.innerHTML = `<div class="vw-bar"><button class="btn" id="vw-close">✕</button>
      <span class="vw-name">${esc(entry.name)}</span></div>
      <div class="vw-body"><div class="note">Opening…</div></div>`;
    viewer.hidden = false;
    viewer.querySelector('#vw-close').onclick = closeViewer;
    let meta;
    try {
      meta = await api(`/api/fs/read?path=${encodeURIComponent(full)}`);
    } catch (err) {
      viewer.querySelector('.vw-body').innerHTML = `<div class="note">${esc(err.message)}</div>`;
      return;
    }
    if (meta.kind === 'text') {
      doc = { ...meta, lines: [], tail: '', shown: 0, wrap: false, loading: false };
      absorb(meta);
      paintDoc();
    } else {
      paintMedia(meta);
    }
  }

  function barHtml(meta, extra = '') {
    return `<div class="vw-bar">
      <button class="btn" id="vw-close">✕</button>
      <span class="vw-name">${esc(meta.name)} · ${fmtSize(meta.size)}</span>
      ${extra}
      ${inSession() ? '<button class="btn" id="vw-insert" title="Put this path in the terminal input">＋ path</button>' : ''}
    </div>`;
  }

  function bindBar(meta) {
    viewer.querySelector('#vw-close').onclick = closeViewer;
    const ins = viewer.querySelector('#vw-insert');
    if (ins) {
      ins.onclick = () => {
        insertPath(meta.path);
        closeViewer();
      };
    }
  }

  function paintMedia(meta) {
    const url = fileUrl(meta.path);
    // A PDF and a hex dump both want the body to scroll from the top rather than
    // be centred like a photo.
    const block = meta.kind === 'pdf' || meta.kind === 'binary';
    const body = meta.kind === 'image' ? `<img src="${url}" alt="">`
      : meta.kind === 'video' ? `<video src="${url}" controls playsinline autoplay></video>`
        : meta.kind === 'audio' ? `<audio src="${url}" controls autoplay></audio>`
          : meta.kind === 'pdf' ? `<iframe class="vw-pdf" src="${url}" title="${esc(meta.name)}"></iframe>`
            : `<div class="vw-hex">${esc(meta.hex || '')}</div>
               <div class="note">Not text — the first kilobyte, as bytes.</div>`;
    // Downloading hands the file to iOS (Files app / share sheet) instead of
    // trying to render something we cannot.
    const extra = block ? `<a class="btn" href="${fileUrl(meta.path, true)}" download title="Download">⤓</a>` : '';
    viewer.innerHTML = `${barHtml(meta, extra)}<div class="vw-body${block ? ' doc' : ''}">${body}</div>`;
    bindBar(meta);
    const media = viewer.querySelector('img, video, audio');
    if (media) {
      // Two different failures land here and the phone cannot tell them apart:
      // the file went away, or iOS has no codec for it (webm, flac, ogg). The
      // download is the way out of the second one.
      media.onerror = () => {
        viewer.querySelector('.vw-body').innerHTML = `<div class="note">Cannot show this one — it may have been moved,
          or this phone has no decoder for it.<br><br>
          <a class="btn" href="${fileUrl(meta.path, true)}" download>⤓ Download instead</a></div>`;
      };
    }
  }

  // A page arrives mid-line as often as not, so the unterminated tail is held
  // back until the next page completes it (or the file ends).
  function absorb(page) {
    const all = doc.tail + page.text;
    const parts = all.split('\n');
    doc.tail = page.eof ? '' : parts.pop();
    if (page.eof && parts[parts.length - 1] === '') parts.pop(); // trailing newline is not a line
    doc.lines.push(...parts);
    doc.next = page.next;
    doc.eof = page.eof;
  }

  const lineHtml = (l) => {
    const cut = l.length > LINE_MAX;
    const text = esc(cut ? l.slice(0, LINE_MAX) : l) || ' ';
    return `<div class="l"><span>${text}${cut ? `<i class="cut">…+${l.length - LINE_MAX} chars</i>` : ''}</span></div>`;
  };

  function paintDoc() {
    const take = doc.lines.slice(0, LINES_PAGE);
    doc.shown = take.length;
    viewer.innerHTML = `${barHtml(doc, '<button class="btn" id="vw-wrap" title="Wrap long lines">⏎</button>')}
      <div class="vw-body doc">
        <div class="vw-text" id="vw-text">${take.map(lineHtml).join('')}</div>
        <div class="note" id="vw-more"></div>
      </div>`;
    bindBar(doc);
    viewer.querySelector('#vw-wrap').onclick = () => {
      doc.wrap = !doc.wrap;
      viewer.querySelector('#vw-text').classList.toggle('wrap', doc.wrap);
    };
    paintMore();
  }

  function paintMore() {
    const el = viewer.querySelector('#vw-more');
    if (!el) return;
    const buffered = doc.lines.length - doc.shown;
    if (!buffered && doc.eof) {
      el.textContent = `${doc.shown} lines · end of file`;
      return;
    }
    const left = doc.eof ? `${buffered} more lines` : `${fmtSize(Math.max(0, doc.size - doc.next))} more`;
    el.innerHTML = `<button class="btn" id="vw-more-btn">▼ Load more · ${esc(left)}</button>`;
    el.querySelector('#vw-more-btn').onclick = more;
  }

  async function more() {
    if (!doc || doc.loading) return;
    doc.loading = true;
    const btn = viewer.querySelector('#vw-more-btn');
    if (btn) btn.textContent = 'Loading…';
    try {
      // Everything already buffered is rendered before another page is asked
      // for: one chunk of a file of short lines is several screens of text.
      if (doc.lines.length - doc.shown < LINES_PAGE && !doc.eof) {
        absorb(await api(`/api/fs/read?path=${encodeURIComponent(doc.path)}&offset=${doc.next}`));
      }
      const take = doc.lines.slice(doc.shown, doc.shown + LINES_PAGE);
      doc.shown += take.length;
      viewer.querySelector('#vw-text')?.insertAdjacentHTML('beforeend', take.map(lineHtml).join(''));
    } catch (err) {
      const el = viewer.querySelector('#vw-more');
      if (el) el.textContent = err.message;
      doc.loading = false;
      return;
    }
    doc.loading = false;
    paintMore();
  }

  return { mount, go, closeViewer };
}
