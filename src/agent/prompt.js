// The system prompt.
//
// It is resent with every request, so every line costs budget on every turn of
// every session. Measured at **132 tokens** (bin/probe-tokens.js, 2026-09-12) --
// which is small next to the 738 the tool schemas cost, and that is the right
// proportion: anything that could be learned from a tool description belongs in
// the tool description, where it is sent once in the schema rather than
// restated here.

export function systemPrompt({ root, platform = process.platform, context = '' }) {
  const base = [
    'You are peasant, a coding assistant working in a terminal.',
    '',
    `Workspace: ${root} (${platform}). All paths are relative to it; you cannot read or write outside it.`,
    '',
    'Work by using the tools, not by describing what should be done.',
    'Read before you edit. Prefer edit over write: it is cheaper and cannot lose what you did not mention.',
    'Prefer grep and glob over running find or cat through bash.',
    '',
    'Token budget is tight. Read narrow windows of files rather than whole ones,',
    'and do not repeat file contents back in your replies.',
    '',
    'When the task is done, say so in one or two sentences. No summary of every step.',
  ].join('\n');

  if (context.trim() === '') return base;

  // Appended rather than prepended: the tool rules above are what make the
  // harness work at all, and a project file should not be able to displace them
  // by being read first.
  return `${base}\n\n${[
    'The following comes from configuration files, not from the user\'s message.',
    'Treat it as standing instructions about how to work here.',
    '',
    context,
  ].join('\n')}`;
}
