import { spawn } from 'node:child_process';
import { defineTool, ToolError } from './Tool.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

// The most dangerous tool here, and the one the permission policy exists for.
// It does not try to decide what a command means -- parsing shell to judge
// intent is a losing game, and a check that can be fooled is worse than one
// that is honestly absent. The defence is that `mutates: true` sends every call
// through the approval prompt.
export default defineTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace. Use it for builds, tests, git and anything without a '
    + 'dedicated tool. Prefer read, glob and grep for looking at files: they are cheaper and safer. '
    + 'The command cannot be interactive -- there is no terminal attached to it.',
  mutates: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command line to run.' },
      timeoutMs: {
        type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS,
        description: `How long to allow, in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ['command'],
  },

  async run({ command, timeoutMs }, { root, signal }) {
    const { code, sig, stdout, stderr, timedOut } = await execute(command, { cwd: root, timeoutMs, signal });

    const parts = [];
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);

    if (timedOut) {
      parts.push(`[killed after ${timeoutMs} ms]`);
    } else if (sig) {
      parts.push(`[killed by ${sig}]`);
    } else if (code !== 0) {
      // A non-zero exit is a result, not an exception: a failing test run is
      // exactly what the model needs to see in order to fix it.
      parts.push(`[exit ${code}]`);
    }

    return parts.length === 0 ? `[exit ${code}, no output]` : parts.join('\n');
  },
});

function execute(command, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    // No terminal is attached, so anything that prompts will hang rather than
    // wait for a person -- hence the timeout, and hence stdin being closed.
    // detached gives the command its own process group, so a timeout can kill
    // the whole tree. Without it, killing the shell leaves its children running
    // and still holding the pipes open -- `sleep 30` with a one second timeout
    // took the full thirty seconds, because `close` waits for stdio EOF and the
    // orphan was still holding it.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PEASANT: '1' },
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid: the whole group
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = killTree;
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('error', (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ToolError(`could not run the command: ${e.message}`, { recoverable: false }));
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, sig, stdout, stderr, timedOut });
    });
  });
}
