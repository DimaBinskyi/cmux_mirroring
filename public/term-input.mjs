// Reading the terminal's input line back out of the render grid, and turning a
// field edit into the minimal pty keystrokes.
//
// Pure functions, no DOM — scripts/test-input-sync.mjs drives them against a
// real cmux surface, which is how the composer shapes below were established.

const PROMPT = '❯'; // ❯ — Claude Code's composer prompt, always at column 0
const INDENT = 2; // composer body starts at column 2 ("❯ " / continuation indent)
const RULE = /^[─━═]{20,}$/; // ─── frame edge above/below the composer
const SHELL_PROMPT = /[❯➜›»$%#>]/;

export function lineText(spans) {
  let line = '';
  let col = 0;
  for (const s of spans) {
    if (s.column > col) line += ' '.repeat(s.column - col);
    line += s.text;
    col = s.column + (s.cell_width || [...s.text].length);
  }
  return line;
}

export function buildRowsModel(g) {
  const total = g.scrollbackRows + g.rows;
  const arr = Array.from({ length: total }, () => []);
  for (const s of g.scrollback) arr[s.row]?.push(s);
  for (const s of g.viewport) arr[g.scrollbackRows + s.row]?.push(s);
  for (const r of arr) r.sort((a, b) => a.column - b.column);
  return arr;
}

// One entry per rendered character, carrying the screen column it starts at —
// columns are what the cursor is reported in, so mapping cursor → text offset
// has to go through them (wide glyphs cover two columns).
function rowCells(spans) {
  const cells = [];
  let col = 0;
  for (const s of spans) {
    while (col < s.column) {
      cells.push([' ', col, 1]);
      col += 1;
    }
    const chars = [...s.text];
    const width = Math.max(1, Math.round((s.cell_width || chars.length) / (chars.length || 1)));
    for (const ch of chars) {
      cells.push([ch, col, width]);
      col += width;
    }
  }
  return cells;
}

// The column just past the last character — where the next one would land.
const endColumn = (cells) => (cells.length ? cells[cells.length - 1][1] + cells[cells.length - 1][2] : 0);

// Width of the leading word, in columns (0 when the row is empty or starts blank).
function firstWordWidth(cells) {
  let i = 0;
  while (i < cells.length && cells[i][0] !== ' ') i += 1;
  return i === 0 ? 0 : endColumn(cells.slice(0, i)) - cells[0][1];
}

const cellsText = (cells) => cells.map((c) => c[0]).join('');

function trimTail(cells) {
  let end = cells.length;
  while (end > 0 && /\s/.test(cells[end - 1][0])) end -= 1;
  return cells.slice(0, end);
}

// Cursor column → index within a row body. Columns before the body (prompt or
// indent) are already gone, so anything left of the first cell clamps to 0.
function indexForColumn(cells, column) {
  for (let i = 0; i < cells.length; i += 1) if (cells[i][1] >= column) return i;
  return cells.length;
}

/**
 * What is currently in the terminal's input line?
 *   { kind: 'composer' | 'shell', text, tail }  — mirror `text` into the field;
 *       `tail` is how many characters sit after the cursor, so the caret can be
 *       placed from either end.
 *   { kind: 'busy' }  — a dialog/menu owns the keyboard (/model, permission
 *       prompts, any TUI): the field must be left exactly as the user left it.
 *   null — nothing recognizable.
 *
 * `afterKey` says the read follows a key the field itself just sent (⇥ ↑ ↓ ^R),
 * which is only ever pressed at an input line — it waives the guard that treats
 * anything drawn below the cursor as a TUI, because that is exactly where a
 * shell prints its completion candidates.
 */
export function parseInput(grid, rowsModel, { afterKey = false } = {}) {
  if (!grid || !grid.cursor || !rowsModel) return null;
  const isFaint = (s) => (grid.styles[s.style_id] || {}).faint;
  // Faint spans are placeholders and hints ("Try …", "? for shortcuts"), never input.
  const cellsAt = (r) => rowCells((rowsModel[grid.scrollbackRows + r] || []).filter((s) => !isFaint(s)));
  const textAt = (r) => cellsText(cellsAt(r)).replace(/\s+$/, '');
  const blank = (r) => !textAt(r).trim();
  const r = grid.cursor.row;

  // --- Claude Code composer -------------------------------------------------
  // Its prompt sits at column 0, between two full-width rules. A menu's
  // selection marker is the same glyph but indented, so the column is what
  // tells "❯ my prompt" apart from "  ❯ 2. Opus (1M context)".
  let start = -1;
  for (let i = r; i >= Math.max(0, r - 40); i -= 1) {
    const t = textAt(i);
    if (RULE.test(t.trim())) break; // frame edge — a composer never spans one
    if (t[0] === PROMPT) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    // Blank rows belong to the composer (the user's own empty lines), so the
    // block ends at the frame rule or at the first non-continuation row.
    let end = start;
    for (let i = start + 1; i < grid.rows; i += 1) {
      const t = textAt(i);
      if (RULE.test(t.trim())) break;
      if (t.trim() && !/^ {2}(?! )/.test(t)) break; // not an indented continuation
      end = i;
    }
    // Trailing blanks are screen, not text — except the one the cursor is on,
    // which is an empty line the user just opened.
    while (end > start && end > r && blank(end)) end -= 1;
    if (r < start || r > end) return { kind: 'busy' }; // composer visible but unfocused
    return composerText(grid, cellsAt, start, end, r);
  }

  // --- Shell prompt ---------------------------------------------------------
  // Guarded so TUI content never leaks into the field: the cursor row must look
  // like a prompt line AND be the last row with content (shells park the cursor
  // at the bottom; menus and dialogs always have a footer below it). Tab
  // completion is the exception — its candidate list is printed right below the
  // prompt — so `afterKey` waives the second half.
  if (!SHELL_PROMPT.test(textAt(r).slice(0, 40))) return null;
  if (!afterKey) for (let i = grid.rows - 1; i > r; i -= 1) if (!blank(i)) return { kind: 'busy' };

  // Prompts are colored or bold, typed input is not: the input is the run of
  // plainly-styled spans that ends the cursor row.
  const spans = (rowsModel[grid.scrollbackRows + r] || []).filter((s) => !isFaint(s));
  if (!spans.length) return null;
  const plain = (s) => {
    const st = grid.styles[s.style_id] || {};
    return (!st.fg || st.fg.toLowerCase() === grid.fg.toLowerCase())
      && (!st.bg || st.bg.toLowerCase() === grid.bg.toLowerCase())
      && !st.bold && !st.inverse && !st.italic;
  };
  let last = spans.length - 1;
  while (last >= 0 && !plain(spans[last])) last -= 1;
  if (last < 0) return null; // nothing plainly styled — leave the field alone
  let from = last + 1;
  while (from > 0 && plain(spans[from - 1])) from -= 1;
  // What a completion inserts comes back styled (zsh bolds the trailing "/" of
  // a directory), so the input does not always end plainly. Take styled spans
  // that sit flush against the plain run too; a right-hand prompt is separated
  // by a gap of blank columns and stays out.
  const spanEnd = (s) => s.column + (s.cell_width || [...s.text].length);
  let to = last + 1;
  while (to < spans.length && spans[to].column === spanEnd(spans[to - 1])) to += 1;
  // Drop the prompt on the cells rather than the string, so the cursor column
  // still maps onto what is left.
  const tail = trimTail(rowCells(spans.slice(from, to)));
  let cut = 0;
  while (cut < tail.length && /\s/.test(tail[cut][0])) cut += 1;
  if (cut < tail.length && /[❯>$%#]/.test(tail[cut][0])) {
    cut += 1;
    if (tail[cut]?.[0] === ' ') cut += 1;
  }
  const body = tail.slice(cut);
  const text = cellsText(body).replace(/\s*│\s*$/, ''); // some prompts draw a right border
  const caret = Math.min(indexForColumn(body, grid.cursor.column), [...text].length);
  return { kind: 'shell', text, tail: Math.max(0, [...text].length - caret) };
}

// Rebuild the composer text from its rows. Telling the user's own line breaks
// apart from the composer's wrapping is what preserves their formatting:
//   - the row filled the line to the edge  -> broken mid-word, join with nothing
//   - the next word would not have fit     -> word-wrapped, join with the space
//     the wrap swallowed
//   - anything else                        -> a line break the user typed
// The text width is the terminal minus the composer's own indent — measured
// against a live composer, which scripts/dump-grid.mjs will show you again.
function composerText(grid, cellsAt, start, end, cursorRow) {
  const limit = grid.columns - INDENT;
  const bodyAt = (i) => trimTail(cellsAt(i)).filter(([, col]) => col >= INDENT);
  let text = '';
  let caret = 0;
  for (let i = start; i <= end; i += 1) {
    const body = bodyAt(i);
    if (i === cursorRow) caret = [...text].length + indexForColumn(body, grid.cursor.column);
    text += cellsText(body);
    if (i === end) break;
    const stop = endColumn(body);
    if (stop >= limit) continue; // filled the line: mid-word break, nothing lost
    if (stop + 1 + firstWordWidth(bodyAt(i + 1)) > limit) text += ' '; // word wrap
    else text += '\n';
  }
  const len = [...text].length;
  caret = Math.min(caret, len);
  return { kind: 'composer', text, tail: Math.max(0, len - caret) };
}

// Turn any field edit (word-delete, selection replace, paste, autocorrect…)
// into the minimal pty edit. Cursor-aware: `caret` is where the pty's cursor
// sits within the input text, the edit region is bounded by common
// prefix+suffix, and the pty cursor is walked to the right edge of that region
// with arrow-key escape sequences before the DELs and the retype.
//
// Returns a list of {t: 'text'|'key', v} ops to hand to the pty in order.
// `lineBreak` picks how a newline is expressed, and the two terminals disagree:
//   'key'    — shift+enter, what the Claude composer wants. Reliable even while
//              its slash-command menu is opening, which backslash+CR is not
//              (it lands as a literal "\", or wipes the composer outright).
//   'escape' — backslash+CR, what a shell wants: a line continuation. A shell
//              does not speak shift+enter and leaks it as ";2;13~".
export function computeEdit(prevValue, newValue, caret, { lineBreak = 'escape' } = {}) {
  const oldCp = [...prevValue];
  const newCp = [...newValue];
  let p = 0;
  while (p < oldCp.length && p < newCp.length && oldCp[p] === newCp[p]) p += 1;
  let sfx = 0;
  while (sfx < oldCp.length - p && sfx < newCp.length - p
    && oldCp[oldCp.length - 1 - sfx] === newCp[newCp.length - 1 - sfx]) sfx += 1;
  const removed = oldCp.length - p - sfx;
  const inserted = newCp.slice(p, newCp.length - sfx).join('');
  const moved = { caret: p + [...inserted].length };
  if (!removed && !inserted) return { ops: [], caret };
  const delta = (p + removed) - caret; // pty cursor must sit at the right edge of the removal
  const DEL = '\u007F';
  const RIGHT = '\u001B[C';
  const LEFT = '\u001B[D';
  const lead = (delta > 0 ? RIGHT.repeat(delta) : LEFT.repeat(-delta)) + DEL.repeat(removed);

  if (lineBreak !== 'key') {
    const v = lead + inserted.replace(/\n/g, '\\\r');
    return { ops: v ? [{ t: 'text', v }] : [], ...moved };
  }
  // Each break is its own key event, with the text around it sent as text.
  const ops = [];
  const parts = inserted.split('\n');
  if (lead + parts[0]) ops.push({ t: 'text', v: lead + parts[0] });
  for (let i = 1; i < parts.length; i += 1) {
    ops.push({ t: 'key', v: 'shift+enter' });
    if (parts[i]) ops.push({ t: 'text', v: parts[i] });
  }
  return { ops, ...moved };
}

// The grid cannot tell a typed trailing space from an erased cell, so compare
// field and terminal ignoring trailing whitespace on every line: if they agree
// that far, the field is authoritative and must not be rewritten.
export const normalizeLines = (s) => String(s).split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');

// Where the pty's cursor sits *in the field*, given the terminal's own text and
// how many characters follow the cursor there (`tail`).
//
// The two strings only agree up to trailing whitespace — the terminal's is
// short by every space the grid could not show — so counting `tail` back from
// the field's end slides the caret right by that many characters, and the next
// edit is then typed one space too early ("some text " + "new" came out as
// "some textnew"). Walk the lines instead: an interior caret has the same index
// in both, and one parked at the end of a line goes to the end of the FIELD's
// line, past whatever trailing spaces only it knows about.
export function caretInField(fieldValue, text, tail = 0) {
  const fieldLines = String(fieldValue).split('\n');
  const textLines = String(text).split('\n');
  let caret = Math.max(0, [...text].length - tail);
  let offset = 0;
  for (let i = 0; i < textLines.length; i += 1) {
    const inText = [...textLines[i]].length;
    const inField = [...(fieldLines[i] ?? textLines[i])].length;
    if (caret <= inText) return offset + (caret === inText ? Math.max(inField, caret) : caret);
    caret -= inText + 1; // this line plus its newline
    offset += inField + 1;
  }
  return [...String(fieldValue)].length;
}
