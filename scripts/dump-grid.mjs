// Debug helper: print the terminal grid rows around the cursor with style flags,
// exactly as public/app.js sees them (faint spans marked).
const surface = process.argv[2];
const around = Number(process.argv[3] || 14);
const base = process.env.BASE || 'http://127.0.0.1:4488';

const g = await fetch(`${base}/api/grid?surface=${encodeURIComponent(surface)}`).then((r) => r.json());
if (g.error) {
  console.error(g.error);
  process.exit(1);
}

const rows = Array.from({ length: g.rows }, () => []);
for (const s of g.viewport) rows[s.row]?.push(s);
for (const r of rows) r.sort((a, b) => a.column - b.column);

const lineText = (spans) => {
  let line = '';
  let col = 0;
  for (const s of spans) {
    if (s.column > col) line += ' '.repeat(s.column - col);
    line += s.text;
    col = s.column + (s.cell_width || [...s.text].length);
  }
  return line;
};

console.log(`columns=${g.columns} rows=${g.rows} cursor=${JSON.stringify(g.cursor)}`);
const r = g.cursor.row;
for (let i = Math.max(0, r - around); i <= Math.min(g.rows - 1, r + around); i += 1) {
  const spans = rows[i] || [];
  const all = lineText(spans);
  const noFaint = lineText(spans.filter((s) => !(g.styles[s.style_id] || {}).faint));
  const mark = i === r ? '>>' : '  ';
  console.log(`${mark}${String(i).padStart(3)} RAW   |${all}|`);
  if (noFaint !== all) console.log(`${mark}${String(i).padStart(3)} NOFNT |${noFaint}|`);
  if (process.env.SPANS) {
    for (const s of spans) {
      const st = g.styles[s.style_id] || {};
      console.log(`      col=${String(s.column).padStart(3)} w=${s.cell_width} ${JSON.stringify(s.text)} ${JSON.stringify(st)}`);
    }
  }
}
