import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

/**
 * The Docker sandbox end to end (Linux with a Docker daemon, as on GitHub-hosted runners):
 * Vitest, coverage, and tsc run in a container without network, report paths still match
 * the host, and a hanging test is stopped together with its container.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'agent', 'src', 'cli.mjs');
const SOURCE = 'backend/src/features/todos/uta-e2e-sample.ts';
const TEST_PATH = 'backend/tests/uta-e2e-sample.test.ts';
const dockerReady = process.platform === 'linux' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const TMP = mkdtempSync(join(tmpdir(), 'uta-docker-'));
const WT = join(TMP, 'wt');

const SAMPLE = `import type { Todo } from './types.js';

export function countCompleted(todos: Pick<Todo, 'completed'>[]): number {
  return todos.filter((todo) => todo.completed).length;
}
`;
const GOOD_TEST = `import { expect, it } from 'vitest';
import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';

it('counts only completed tasks', () => {
  expect(countCompleted([{ completed: true }, { completed: false }])).toBe(1);
});
`;
const LOOP_TEST = `import { expect, it } from 'vitest';
import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';

it('counts only completed tasks', () => {
  expect(countCompleted([{ completed: true }])).toBe(1);
  while (Date.now() > 0) {}
});
`;

function git(args, cwd = WT) {
  const out = spawnSync('git', ['-c', 'user.name=uta-test', '-c', 'user.email=uta-test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function uta(args, env = {}) {
  const childEnv = {
    ...process.env,
    TEST_SANDBOX: 'docker',
    UTA_SANDBOX_MOUNTS: `${join(REPO, 'backend', 'node_modules')},${join(REPO, 'frontend', 'node_modules')}`,
    ...env,
  };
  delete childEnv.CI;
  delete childEnv.GITHUB_ACTIONS;
  const out = spawnSync(process.execPath, [CLI, ...args, '--root', WT], { cwd: WT, encoding: 'utf8', env: childEnv, timeout: 900_000 });
  return { code: out.status, json: JSON.parse(out.stdout), stdout: out.stdout, stderr: out.stderr };
}

function reset() {
  git(['reset', '-q', '--hard', 'HEAD']);
  git(['clean', '-fdq', '-e', 'node_modules', '--', 'backend', 'frontend']);
  rmSync(join(WT, '.uta-runs'), { recursive: true, force: true });
}

before(() => {
  if (!dockerReady) return;
  assert.equal(spawnSync('docker', ['pull', '-q', loadConfig({}).sandboxImage], { stdio: 'ignore' }).status, 0, 'sandbox image pulls');
  git(['worktree', 'add', '--detach', WT, 'HEAD'], REPO);
  for (const side of ['backend', 'frontend']) symlinkSync(join(REPO, side, 'node_modules'), join(WT, side, 'node_modules'));
  cpSync(join(REPO, 'backend', 'src', 'generated'), join(WT, 'backend', 'src', 'generated'), { recursive: true });
  writeFileSync(join(WT, SOURCE), SAMPLE);
  git(['add', SOURCE]);
  git(['commit', '-qm', 'feat: count completed tasks (harness test fixture)']);
});

after(() => {
  if (!dockerReady) return;
  for (const side of ['backend', 'frontend']) {
    const link = join(WT, side, 'node_modules');
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
  spawnSync('git', ['worktree', 'remove', '--force', WT], { cwd: REPO });
  rmSync(TMP, { recursive: true, force: true });
});

describe('docker sandbox', { skip: !dockerReady && 'needs Linux with a Docker daemon', timeout: 900_000 }, () => {
  it('runs gates in the container and maps coverage back to host paths', () => {
    reset();
    const script = join(TMP, 'good.json');
    writeFileSync(script, JSON.stringify({ [SOURCE]: [{ files: { [TEST_PATH]: GOOD_TEST } }] }));
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'stub', '--stub', script]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(run.json.targets.map((t) => t.status), ['accepted']);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
    assert.ok(state.targets[0].coverage.gained > 0, 'coverage from the container maps to the host source path');
    assert.equal(state.final.backend.status, 'pass');
  });

  it('stops a hanging test together with its container', () => {
    reset();
    const script = join(TMP, 'loop.json');
    writeFileSync(script, JSON.stringify({ [SOURCE]: [{ files: { [TEST_PATH]: LOOP_TEST } }] }));
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'stub', '--stub', script], { UTA_COMMAND_TIMEOUT_MS: '10000', UTA_MAX_REPAIRS: '0' });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
    assert.equal(state.targets[0].history[0].class, 'timeout');
    const leftover = spawnSync('docker', ['ps', '-q', '--filter', 'name=uta-'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(leftover, '', 'no sandbox container keeps running');
  });
});
