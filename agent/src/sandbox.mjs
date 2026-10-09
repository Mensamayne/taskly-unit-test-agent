import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, safeEnv } from './lib/exec.mjs';

/**
 * Run `node <args>` inside a package directory (`frontend` or `backend`).
 *
 * - local: subprocess with an allowlisted environment (no secrets).
 * - docker: throwaway container, no network, resource limits. The repository is mounted at
 *   the same absolute path as on the host, so paths in Vitest and coverage reports match.
 *
 * `args` must use paths relative to the package directory with forward slashes,
 * so the same arguments work on the host and in the container.
 *
 * @param {{ root: string, side: 'frontend' | 'backend', args: string[], config: import('./config.mjs').Config, timeoutMs?: number }} opts
 */
export async function runNode({ root, side, args, config, timeoutMs }) {
  const timeout = timeoutMs ?? config.budgets.commandTimeoutMs;
  if (config.sandbox === 'docker') {
    const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    // Killing the docker client does not stop the container; name it so a timeout can.
    const name = `uta-${process.pid}-${randomBytes(4).toString('hex')}`;
    const dockerArgs = [
      'run', '--rm', '--name', name, '--network', 'none',
      '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
      ...user,
      '-e', 'CI=true', '-e', 'TZ=UTC', '-e', 'NO_COLOR=1', '-e', 'HOME=/tmp',
      '-v', `${root}:${root}`,
      // Dependencies that live outside the repository (linked worktrees, pnpm stores), read-only.
      ...config.sandboxMounts.flatMap((dir) => ['-v', `${dir}:${dir}:ro`]),
      '-w', `${root}/${side}`,
      config.sandboxImage, 'node', ...args,
    ];
    // The docker client itself needs no secrets either.
    return runCommand('docker', dockerArgs, {
      env: safeEnv(),
      timeoutMs: timeout + 30_000,
      onTimeout: () => spawnSync('docker', ['kill', name], { stdio: 'ignore', timeout: 20_000 }),
    });
  }
  return runCommand(process.execPath, args, { cwd: join(root, side), env: safeEnv(), timeoutMs: timeout });
}

/** Ensure a directory exists and return it. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
