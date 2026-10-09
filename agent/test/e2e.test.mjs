import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end runs of the real CLI against a disposable git worktree of this repository.
 * Vitest and tsc run for real; only the author is replaced (stub or a scripted external author).
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'agent', 'src', 'cli.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'uta-e2e-'));
const WT = join(TMP, 'wt');

const STATS = `import type { Todo } from './types.js';

export function countCompleted(todos: Pick<Todo, 'completed'>[]): number {
  return todos.filter((todo) => todo.completed).length;
}
`;

const WRONG_TEST = `import { expect, it } from 'vitest';
import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';

it('counts completed tasks', () => {
  expect(countCompleted([{ completed: true }, { completed: false }])).toBe(2);
});
`;

const GOOD_TEST = `import { describe, expect, it } from 'vitest';
import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';

describe('countCompleted', () => {
  it('counts only completed tasks', () => {
    expect(countCompleted([{ completed: true }, { completed: false }, { completed: true }])).toBe(2);
  });
  it('returns zero for an empty list', () => {
    expect(countCompleted([])).toBe(0);
  });
});
`;

function git(args, cwd = WT) {
  const out = spawnSync('git', ['-c', 'user.name=uta-test', '-c', 'user.email=uta-test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function uta(args, { env = {}, input } = {}) {
  const baseEnv = { ...process.env, ...env };
  delete baseEnv.CI;
  delete baseEnv.GITHUB_ACTIONS;
  const out = spawnSync(process.execPath, [CLI, ...args, '--root', WT], { cwd: WT, encoding: 'utf8', env: baseEnv, input, timeout: 600_000 });
  let json = null;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    // not JSON (e.g. `uta packet`)
  }
  return { code: out.status, json, stdout: out.stdout, stderr: out.stderr };
}

function resetWorktree() {
  git(['reset', '--hard', 'HEAD']);
  git(['clean', '-fdq', '-e', 'node_modules', '--', 'backend', 'frontend']);
  rmSync(join(WT, '.uta-runs'), { recursive: true, force: true });
}

before(() => {
  git(['worktree', 'add', '--detach', WT, 'HEAD'], REPO);
  for (const side of ['backend', 'frontend']) {
    symlinkSync(join(REPO, side, 'node_modules'), join(WT, side, 'node_modules'), 'junction');
  }
  cpSync(join(REPO, 'backend', 'src', 'generated'), join(WT, 'backend', 'src', 'generated'), { recursive: true });
  writeFileSync(join(WT, 'backend', 'src', 'features', 'todos', 'uta-e2e-sample.ts'), STATS);
  git(['add', 'backend/src/features/todos/uta-e2e-sample.ts']);
  git(['commit', '-qm', 'feat: count completed tasks (harness test fixture)']);
});

/** Remove the dependency links before anything deletes the worktree, so no tool follows them into the real node_modules. */
function unlinkDependencies() {
  for (const side of ['backend', 'frontend']) {
    const link = join(WT, side, 'node_modules');
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
}

after(() => {
  unlinkDependencies();
  spawnSync('git', ['worktree', 'remove', '--force', WT], { cwd: REPO });
  rmSync(TMP, { recursive: true, force: true });
});

describe('uta end to end', { timeout: 600_000 }, () => {
  it('plans the new file, repairs a wrong test, accepts the fix, and reports', () => {
    resetWorktree();
    const script = join(TMP, 'stub.json');
    writeFileSync(script, JSON.stringify({
      'backend/src/features/todos/uta-e2e-sample.ts': [
        { files: { 'backend/tests/uta-e2e-sample.test.ts': WRONG_TEST }, result: { cases: ['counts completed tasks'] } },
        { files: { 'backend/tests/uta-e2e-sample.test.ts': GOOD_TEST }, result: { cases: ['counts only completed tasks', 'empty list'] } },
      ],
    }));
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'stub', '--stub', script]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.equal(run.json.outcome, 'done');
    assert.deepEqual(run.json.targets.map((t) => [t.path, t.action, t.status, t.attempts]), [
      ['backend/src/features/todos/uta-e2e-sample.ts', 'write', 'accepted', 2],
    ]);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', readFileSync(join(WT, '.uta-runs', 'latest'), 'utf8'), 'state.json'), 'utf8'));
    assert.equal(state.targets[0].history[0].gate, 'G4');
    assert.equal(state.targets[0].history[0].class, 'assertion');
    assert.equal(state.final.backend.status, 'pass');
    const report = readFileSync(run.json.artifacts.report, 'utf8');
    assert.match(report, /Tests passed/);
    assert.match(report, /attempt 1: G4 assertion/);
    const patch = readFileSync(run.json.artifacts.patch, 'utf8');
    assert.match(patch, /\+\+\+ b\/backend\/tests\/uta-e2e-sample\.test\.ts/);
    assert.match(patch, /returns zero for an empty list/);
  });

  it('lets an external author drive the run and fails it on a write outside the target', () => {
    resetWorktree();
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'external']);
    assert.equal(run.code, 3, run.stdout + run.stderr);
    assert.equal(run.json.awaiting.testPath, 'backend/tests/uta-e2e-sample.test.ts');

    const packet = uta(['packet', '--target', 't1']);
    assert.match(packet.stdout, /This is the only file you may write/);

    const hookDeny = uta(['hook'], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(WT, 'backend', 'src', 'features', 'todos', 'uta-e2e-sample.ts') } }) });
    assert.equal(hookDeny.json.hookSpecificOutput.permissionDecision, 'deny');
    const hookAllow = uta(['hook'], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(WT, 'backend', 'tests', 'uta-e2e-sample.test.ts') } }) });
    assert.equal(hookAllow.stdout.trim(), '');

    const early = uta(['gate', '--target', 't1']);
    assert.equal(early.code, 1);
    assert.equal(early.json.error.code, 'illegal_transition');

    mkdirSync(join(WT, 'backend', 'tests'), { recursive: true });
    writeFileSync(join(WT, 'backend', 'tests', 'uta-e2e-sample.test.ts'), GOOD_TEST);
    writeFileSync(join(WT, 'backend', 'src', 'features', 'todos', 'uta-e2e-sample.ts'), STATS.replace('.length', '.length + 0'));
    const resultFile = join(TMP, 'result.json');
    writeFileSync(resultFile, JSON.stringify({ cases: ['counts only completed tasks'] }));
    assert.equal(uta(['submit', '--target', 't1', '--result', resultFile]).code, 0);

    const gate = uta(['gate', '--target', 't1']);
    assert.equal(gate.code, 4, gate.stdout);
    assert.equal(gate.json.outcome, 'run-failed');
    assert.equal(gate.json.gate, 'G1');
    assert.match(gate.json.message, /backend\/src\/features\/todos\/uta-e2e-sample\.ts/);
    assert.equal(existsSync(join(WT, '.uta-runs', '.active')), false);
    assert.equal(uta(['status']).json.failure.code, 'scope_violation');
  });

  it('reverts a test that writes to production code, then stops on a resubmitted failing file', () => {
    resetWorktree();
    const tamper = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { expect, it } from 'vitest';",
      "import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';",
      '',
      "it('counts completed tasks', () => {",
      "  const target = new URL('../src/features/todos/mappers.ts', import.meta.url);",
      "  writeFileSync(target, `${readFileSync(target, 'utf8')}// tampered\\n`);",
      '  expect(countCompleted([{ completed: true }, { completed: false }])).toBe(1);',
      '});',
      '',
    ].join('\n');
    const script = join(TMP, 'stub-edge.json');
    const testPath = 'backend/tests/uta-e2e-sample.test.ts';
    writeFileSync(script, JSON.stringify({
      'backend/src/features/todos/uta-e2e-sample.ts': [
        { files: { [testPath]: tamper } },
        { files: { [testPath]: WRONG_TEST } },
        { files: { [testPath]: WRONG_TEST } },
      ],
    }));
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'stub', '--stub', script]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
    const [target] = state.targets;
    assert.equal(target.status, 'rejected');
    assert.deepEqual(target.history.map((h) => `${h.gate} ${h.class}`), ['G4 side-effect', 'G4 assertion', 'G0 no-progress']);
    assert.match(target.history[0].message, /backend\/src\/features\/todos\/mappers\.ts/);
    const dirty = spawnSync('git', ['status', '--porcelain', '--', 'backend/src'], { cwd: WT, encoding: 'utf8' }).stdout.trim();
    assert.equal(dirty, '', 'the production file was reverted');
    assert.equal(existsSync(join(WT, testPath)), false, 'the rejected test file was removed');
  });

  it('ends the run with a report when the author fails', () => {
    resetWorktree();
    const script = join(TMP, 'stub-throw.json');
    writeFileSync(script, JSON.stringify({ 'backend/src/features/todos/uta-e2e-sample.ts': [{ throw: 'model API unavailable' }] }));
    const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'stub', '--stub', script]);
    assert.equal(run.code, 4, run.stdout + run.stderr);
    assert.equal(run.json.failure.code, 'author_error');
    assert.match(run.json.failure.message, /model API unavailable/);
    assert.equal(existsSync(join(WT, '.uta-runs', '.active')), false);
    assert.match(readFileSync(run.json.artifacts.report, 'utf8'), /Run failed: author_error/);
  });

  it('plans a repair when the pull request breaks existing tests', () => {
    resetWorktree();
    const validators = join(WT, 'backend', 'src', 'features', 'todos', 'validators.ts');
    writeFileSync(validators, readFileSync(validators, 'utf8').replace('.min(1).max(120)', '.min(1).max(100)'));
    git(['commit', '-qam', 'change title limit']);
    try {
      const run = uta(['run', '--mode', 'pr', '--base', 'HEAD~2', '--author', 'external']);
      assert.equal(run.code, 3, run.stdout + run.stderr);
      const targets = Object.fromEntries(run.json.targets.map((t) => [t.path, t.action]));
      assert.equal(targets['backend/src/features/todos/validators.ts'], 'repair-existing');
      assert.equal(run.json.awaiting.testPath, 'backend/tests/validators.test.ts', 'repairs are handled first');
      const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
      assert.ok(state.baseline.backend.failingTests.some((t) => t.startsWith('backend/tests/validators.test.ts|')));
      assert.equal(uta(['abort']).code, 0);
    } finally {
      git(['reset', '-q', '--hard', 'HEAD~1']);
    }
  });

  it('refuses the external driver in CI', () => {
    resetWorktree();
    const out = spawnSync(process.execPath, [CLI, 'run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'external', '--root', WT], {
      cwd: WT, encoding: 'utf8', env: { ...process.env, CI: 'true' },
    });
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout).error.code, 'external_in_ci');
  });
});
