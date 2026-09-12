// One question, no tools, no file access. The cheapest thing peasant does.

import { build } from './context.js';
import { EventPrinter } from './EventPrinter.js';

export async function ask(term, env, prompt, { signal }) {
  if (prompt.trim() === '') {
    term.error('nothing to ask. Try: peasant ask "why is the sky blue?"');
    return 64;
  }

  const { router } = await build(term, env, { signal });
  const printer = new EventPrinter(term, { showTools: false });
  let model = null;

  for await (const ev of router.stream(
    { messages: [{ role: 'user', content: prompt }], signal },
    { estimatedTokens: estimate(prompt) },
  )) {
    printer.handle(ev);
    if (ev.type === 'done') model = ev.result.model;
  }

  term.line(printer.summary({ model }));
  for (const [name, why] of router.retired) {
    term.error(term.paint(`  ${name} withdrawn for this session: ${why}`, 'yellow'));
  }
  return 0;
}

// Crude, and knowingly so: it exists only to give the limiter something to
// refuse. TokenEstimator replaces it in Phase 4.
function estimate(text) {
  return Math.ceil(text.length / 4) + 512;
}
