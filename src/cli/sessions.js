// Listing what has been kept.

import { Store } from '../session/Store.js';

export async function sessions(term, env, { limit = 20 } = {}) {
  const store = Store.open({ env });
  const listed = store.list({ limit });

  if (listed.length === 0) {
    term.line(term.paint(`no sessions kept yet (${store.dir})`, 'grey'));
    return 0;
  }

  const cwd = process.cwd();
  for (const s of listed) {
    const here = s.root === cwd ? term.paint(' · here', 'cyan') : '';
    term.line(`${term.paint(s.id, 'bold')}${here}`);
    term.line(term.paint(`  ${s.summary ?? '(nothing said)'}`, 'grey'));
    term.line(term.paint(
      `  ${s.messages} message${s.messages === 1 ? '' : 's'}`
      + `${s.turns ? `, ${s.turns} turns` : ''} · ${s.root ?? 'unknown directory'}`, 'grey'));
  }
  term.line('');
  term.line(term.paint('resume the most recent one here with: peasant --resume', 'grey'));
  return 0;
}
