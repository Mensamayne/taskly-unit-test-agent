import { spawn } from 'node:child_process';

const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'WINDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
];

/**
 * Environment for child processes that run repository code.
 * Only OS plumbing is copied; secrets such as ANTHROPIC_API_KEY or GITHUB_TOKEN never pass.
 * @param {Record<string, string>} [extra]
 * @param {NodeJS.ProcessEnv} [source]
 */
export function safeEnv(extra = {}, source = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = String(source[key]);
  }
  return { ...env, CI: 'true', TZ: 'UTC', LANG: 'en_US.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

/**
 * Run a command without a shell and capture exit code, stdout, stderr.
 * Output is capped to the last `maxOutput` characters per stream.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxOutput?: number, input?: string }} [opts]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, durationMs: number }>}
 */
export function runCommand(command, args, opts = {}) {
  const { cwd, env = process.env, timeoutMs = 120_000, maxOutput = 200_000, input } = opts;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const cap = (text) => (text.length > maxOutput ? text.slice(-maxOutput) : text);
    const finish = (exitCode, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout,
        stderr: extraErr ? `${stderr}\n${extraErr}`.trim() : stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(124, `timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = cap(stdout + String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr = cap(stderr + String(chunk));
    });
    child.on('error', (err) => finish(127, err.message));
    child.on('close', (code) => finish(code ?? 1));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}
