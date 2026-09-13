// Read-only file browsing for the phone: one directory per request, text paged
// in fixed chunks, raw bytes for media. Everything here is confined to the home
// directory — this endpoint is reachable from the tailnet, so the confinement
// and the deny-list below are the only things between a phone browser and every
// key on the Mac. Nothing in this module writes.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// realpath: /Users/x and its symlinked forms have to compare equal, or the
// containment check below rejects paths that are plainly inside home.
export const HOME = (() => {
  try {
    return fs.realpathSync(os.homedir());
  } catch {
    return os.homedir();
  }
})();

const MAX_ENTRIES = 1000;
export const TEXT_CHUNK = 256 * 1024; // one page of a text file
const SNIFF_BYTES = 8192;
const HEX_BYTES = 1024;

// macOS privacy (TCC) does not answer a launchd agent with "permission denied"
// for ~/Desktop, ~/Downloads or ~/Documents. It blocks the call while a consent
// dialog waits for someone to notice it, and the libuv thread that call is
// sitting on never comes back — four of those and every asynchronous file
// operation in the server is stuck behind them.
//
// So: every call here is on a leash, and a folder that has already hung once is
// refused instantly instead of costing another thread. One folder condemns
// itself, not the whole tree, and `clearStall` gives it another chance once the
// user has granted access.
const FS_TIMEOUT_MS = 4000;
const stalled = new Set();

// ~/Desktop/a/b and ~/Desktop are the same permission, so they share a verdict.
function stallKey(p) {
  const rel = path.relative(HOME, p);
  return rel && !rel.startsWith('..') ? rel.split(path.sep)[0] : '';
}

export const isStalled = (p) => stalled.has(stallKey(p));
export const clearStall = (p) => stalled.delete(stallKey(p));

async function leash(p, fn) {
  if (isStalled(p)) throw Object.assign(new Error('blocked by macOS privacy'), { code: 'ESTALLED' });
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ESTALLED' })), FS_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err.code === 'ESTALLED') stalled.add(stallKey(p));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Directory names that are a credential store wherever they turn up.
const DENY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.password-store', 'Keychains']);

// ~/Library is where macOS keeps every app's tokens, cookies, keychains and
// browser profiles. Nobody browses it from a phone to read code, and enumerating
// what inside it is sensitive would be a losing game — the whole tree is out.
const DENY_ROOTS = [path.join(HOME, 'Library')];

// Matched against the file name alone, so a key is blocked wherever it sits.
const DENY_NAMES = [
  /^\.env($|\.)/i,
  /^\.(netrc|npmrc|pgpass|git-credentials)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^credentials$/i,
  /credentials\.json$/i,
  /^socket-control-password$/,
  /^telegram-notify\.json$/i,
  /\.keychain(-db)?$/i,
];

// Media is the only thing served as its own type. Note what is NOT here:
// .html and .svg fall through to text/plain on purpose, because these routes are
// same-origin with the app — an HTML file or a scripted SVG rendered as itself
// would run on the app's origin and could call every other /api/ route. You see
// the source instead, which for a code browser is usually what you wanted.
const MEDIA_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

const KIND_BY_EXT = [
  [/\.(jpe?g|png|gif|webp|avif|bmp|ico|heic|heif)$/i, 'image'],
  [/\.(mp4|m4v|mov|webm)$/i, 'video'],
  [/\.(mp3|m4a|wav|aac|flac|ogg)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
];

// The type the browser is told a file is. Anything that is not media reads as
// plain text — see the comment on MEDIA_MIME for why that matters.
export function contentType(name) {
  return MEDIA_MIME[path.extname(name).toLowerCase()] || 'text/plain; charset=utf-8';
}

export function mediaKind(name) {
  return KIND_BY_EXT.find(([re]) => re.test(name))?.[1] || null;
}

// null = readable. A string = why not, which the listing shows as a lock rather
// than hiding the row: the name is not the secret, the contents are, and a file
// silently missing from a listing is just confusing.
export function blockedReason(abs) {
  if (DENY_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep))) return 'system';
  const rel = path.relative(HOME, abs);
  if (!rel) return null;
  const parts = rel.split(path.sep);
  if (parts.some((seg) => DENY_DIRS.has(seg))) return 'secret';
  const name = parts[parts.length - 1];
  return DENY_NAMES.some((re) => re.test(name)) ? 'secret' : null;
}

// A client-supplied path resolved to an absolute one inside home, or null.
// `~` is expanded here so the phone can hand back the display form it was given.
export function resolvePath(input) {
  const raw = String(input || '~').trim();
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(HOME, raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) return null;
  // normalize first so a textual `..` cannot survive, then realpath so a symlink
  // cannot walk out either. A path that does not exist keeps its normalized form
  // and fails later as a 404, which is the honest answer for a typed path.
  const abs = path.normalize(expanded);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    real = abs;
  }
  return real === HOME || real.startsWith(HOME + path.sep) ? real : null;
}

export const display = (abs) => (abs === HOME ? '~' : abs.startsWith(HOME + path.sep) ? `~${abs.slice(HOME.length)}` : abs);

// Every path the browser touches is stat'd through here — asynchronously and on
// the leash, because the synchronous version of this call blocks the whole
// server when macOS decides to think about it.
export const statPath = (abs) => leash(abs, () => fsp.stat(abs));

// Sorted dirs-first and capped: a phone cannot show 40k entries and should not
// be made to try. Only the entries that survive the cap are stat'd.
export const listDir = (abs, opts) => leash(abs, () => readDir(abs, opts));

async function readDir(abs, { hidden = false } = {}) {
  const all = await fsp.readdir(abs, { withFileTypes: true });
  const visible = hidden ? all : all.filter((d) => !d.name.startsWith('.'));
  visible.sort((a, b) => (b.isDirectory() - a.isDirectory())
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const slice = visible.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(slice.map(async (d) => {
    const full = path.join(abs, d.name);
    let st = null;
    try {
      st = await fsp.stat(full); // follows the link: what you would open
    } catch {
      /* broken symlink, or a directory we may not read */
    }
    const dir = st ? st.isDirectory() : d.isDirectory();
    return {
      name: d.name,
      dir,
      size: st && !dir ? st.size : 0,
      mtime: st ? Math.round(st.mtimeMs) : 0,
      link: d.isSymbolicLink() || undefined,
      blocked: blockedReason(full) || (st ? undefined : 'unreadable'),
    };
  }));
  return { entries, total: visible.length, truncated: visible.length > slice.length };
}

// Control characters that are not tab/newline/CR, plus any NUL, mean bytes the
// text view would render as garbage. High bytes are left alone — they are how
// UTF-8 spells everything outside ASCII.
export function looksBinary(buf) {
  if (buf.includes(0)) return true;
  let odd = 0;
  for (const b of buf) if (b < 9 || (b > 13 && b < 32) || b === 127) odd += 1;
  return buf.length > 0 && odd / buf.length > 0.1;
}

// A fixed-size window lands mid-character eventually; dropping the partial tail
// keeps replacement characters out of files that do not contain any. The next
// page picks up exactly where this one stopped.
function trimPartialUtf8(buf, eof) {
  if (eof || !buf.length) return buf;
  for (let i = buf.length - 1, back = 0; i >= 0 && back < 4; i -= 1, back += 1) {
    const b = buf[i];
    if ((b & 0xC0) === 0x80) continue; // continuation byte, keep walking back
    const len = b < 0x80 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : (b & 0xF8) === 0xF0 ? 4 : 1;
    return back + 1 >= len ? buf : buf.subarray(0, i);
  }
  return buf;
}

function hexDump(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

// One page of a file, starting at `offset`. Media never reaches here — the
// client asks for those as a URL the browser fetches itself.
export const readPage = (abs, st, offset = 0) => leash(abs, () => readPageAt(abs, st, offset));

async function readPageAt(abs, st, offset) {
  const want = Math.max(0, Math.min(TEXT_CHUNK, st.size - offset));
  const buf = Buffer.alloc(want);
  if (want) {
    const fh = await fsp.open(abs, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (bytesRead < want) return finish(buf.subarray(0, bytesRead), offset, st);
    } finally {
      await fh.close();
    }
  }
  return finish(buf, offset, st);
}

function finish(buf, offset, st) {
  if (offset === 0 && looksBinary(buf.subarray(0, SNIFF_BYTES))) {
    return { kind: 'binary', size: st.size, hex: hexDump(buf.subarray(0, HEX_BYTES)) };
  }
  const eof = offset + buf.length >= st.size;
  const usable = trimPartialUtf8(buf, eof);
  const next = offset + usable.length;
  return {
    kind: 'text',
    text: usable.toString('utf8'),
    offset,
    next,
    eof: next >= st.size,
    size: st.size,
  };
}

// The phone's key for these routes. Generated once and kept next to the push
// keys; the user copies it into Settings on the phone.
export function ensureKey(dataDir) {
  const file = path.join(dataDir, 'fs-key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* first run */
  }
  const key = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export function keyMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
