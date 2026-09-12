// Showing what an edit will do.
//
// Not a diff algorithm: `edit` already knows the exact old and new text, so
// there is nothing to infer. The job is only to show it in the shape people
// read diffs in, and to keep it short -- a permission prompt that takes a
// screen is one people stop reading.

const MAX_LINES = 12;

export function renderEdit(terminal, { path, old, replacement, all = false }) {
  const out = [];
  out.push(terminal.paint(`${path}${all ? '  (every occurrence)' : ''}`, 'bold'));

  for (const line of clip(String(old).split('\n'))) {
    out.push(terminal.paint(`  - ${line}`, 'red'));
  }
  for (const line of clip(String(replacement).split('\n'))) {
    out.push(terminal.paint(`  + ${line}`, 'green'));
  }
  return out;
}

export function renderWrite(terminal, { path, content, existed = false }) {
  const lines = String(content).split('\n');
  const out = [
    terminal.paint(`${existed ? 'replace' : 'create'} ${path}`, 'bold'),
    terminal.paint(`  ${lines.length} line${lines.length === 1 ? '' : 's'}`, 'grey'),
  ];
  for (const line of clip(lines)) out.push(terminal.paint(`  + ${line}`, 'green'));
  return out;
}

// Head and tail, because the end of a block is often where the point is.
function clip(lines) {
  if (lines.length <= MAX_LINES) return lines;
  const keep = Math.floor(MAX_LINES / 2);
  return [
    ...lines.slice(0, keep),
    `... ${lines.length - keep * 2} more lines ...`,
    ...lines.slice(-keep),
  ];
}
