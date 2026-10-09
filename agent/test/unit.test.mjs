import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { formatRanges, loadLineCoverage, uncoveredLines } from '../src/coverage.mjs';
import { checkRead, checkWrite, evaluateToolUse, isWritablePath, toRepoRelative } from '../src/guard.mjs';
import { parseAddedLines } from '../src/lib/git.mjs';
import { renderTaskPacket, validateResult } from '../src/packet.mjs';
import { planBootstrap, planPullRequest, testPathFor } from '../src/plan.mjs';
import { renderReport, verificationLine } from '../src/report.mjs';
import { expectStatus, nextStep } from '../src/state.mjs';
import { blocksWithoutExpect, extractTitles, findDisallowedMarkers, importSpecifiers, removedAssertionLines } from '../src/testfile.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'uta-unit-'));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

describe('guard', () => {
  it('accepts only test files in the allowed trees', () => {
    assert.ok(isWritablePath('backend/tests/router.test.ts'));
    assert.ok(isWritablePath('backend/tests/nested/stats.test.ts'));
    assert.ok(isWritablePath('frontend/src/features/todos/TodoList.test.tsx'));
    assert.ok(isWritablePath('frontend/src/lib/http.test.ts'));
    for (const path of [
      'backend/src/factory.ts',
      'backend/tests/fixture.ts',
      'backend/vitest.config.ts',
      'frontend/src/test/setup.ts',
      'frontend/package.json',
      'frontend/src/App.tsx',
      'backend/tests/.test.ts',
      '.github/workflows/x.test.ts',
      'agent/test/unit.test.ts',
    ]) {
      assert.equal(isWritablePath(path), false, path);
    }
  });

  it('rejects traversal, absolute paths outside the root, and null bytes', () => {
    assert.equal(toRepoRelative(ROOT, '../outside.test.ts'), null);
    assert.equal(toRepoRelative(ROOT, 'backend/tests/../../../x.test.ts'), null);
    assert.equal(toRepoRelative(ROOT, join(tmpdir(), 'elsewhere', 'a.test.ts')), null);
    assert.equal(toRepoRelative(ROOT, 'backend/tests/a.test.ts\0'), null);
    assert.equal(toRepoRelative(ROOT, join(ROOT, 'backend', 'tests', 'a.test.ts')), 'backend/tests/a.test.ts');
    assert.equal(checkWrite(ROOT, 'backend/tests/../src/factory.ts').ok, false);
  });

  it('narrows writes to the current target when a list is given', () => {
    assert.equal(checkWrite(ROOT, 'backend/tests/a.test.ts', ['backend/tests/a.test.ts']).ok, true);
    const other = checkWrite(ROOT, 'backend/tests/b.test.ts', ['backend/tests/a.test.ts']);
    assert.equal(other.ok, false);
    assert.match(other.reason, /outside the current target/);
  });

  it('denies reading secrets and run state', () => {
    assert.equal(checkRead(ROOT, '.env').ok, false);
    assert.equal(checkRead(ROOT, 'backend/.env.local').ok, false);
    assert.equal(checkRead(ROOT, 'certs/key.pem').ok, false);
    assert.equal(checkRead(ROOT, '.uta-runs/x/state.json').ok, false);
    assert.equal(checkRead(ROOT, '.env.example').ok, false);
    assert.equal(checkRead(ROOT, 'backend/src/factory.ts').ok, true);
  });

  it('only enforces the hook while a run is active', () => {
    const write = { tool_name: 'Write', tool_input: { file_path: join(ROOT, 'backend', 'src', 'factory.ts') } };
    assert.equal(evaluateToolUse(ROOT, write, null).decision, 'allow');
    const active = { allowedWrites: ['backend/tests/factory.test.ts'] };
    assert.equal(evaluateToolUse(ROOT, write, active).decision, 'deny');
    assert.equal(evaluateToolUse(ROOT, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'backend/src/x.ipynb' } }, active).decision, 'deny');
    assert.equal(evaluateToolUse(ROOT, { tool_name: 'Read', tool_input: { file_path: '.env' } }, active).decision, 'deny');
    const ok = { tool_name: 'Edit', tool_input: { file_path: 'backend/tests/factory.test.ts' } };
    assert.equal(evaluateToolUse(ROOT, ok, active).decision, 'allow');
  });
});

describe('config', () => {
  it('clamps budgets to their hard maximum and ignores garbage', () => {
    const c = loadConfig({ UTA_MAX_TARGETS: '500', UTA_MAX_REPAIRS: '9', UTA_USD_PER_RUN: 'lots', TEST_SANDBOX: 'vm' });
    assert.equal(c.budgets.maxTargets, 20);
    assert.equal(c.budgets.maxRepairs, 2);
    assert.equal(c.budgets.usdPerRun, 6);
    assert.equal(c.sandbox, 'local');
  });
});

describe('git diff parsing', () => {
  it('collects added line numbers per new path', () => {
    const diff = [
      'diff --git a/backend/src/a.ts b/backend/src/a.ts',
      '--- a/backend/src/a.ts',
      '+++ b/backend/src/a.ts',
      '@@ -3,0 +4,2 @@',
      '+x', '+y',
      '@@ -10 +12 @@',
      '-old', '+new',
      '@@ -20,3 +21,0 @@',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
    ].join('\n');
    const added = parseAddedLines(diff);
    assert.deepEqual(added.get('backend/src/a.ts'), [4, 5, 12]);
    assert.equal(added.has('gone.ts'), false);
  });
});

describe('coverage', () => {
  it('derives line coverage from statement starts', () => {
    const file = join(ROOT, 'coverage-final.json');
    const src = join(ROOT, 'backend', 'src', 'a.ts');
    writeFileSync(file, JSON.stringify({
      [src]: {
        statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } }, 2: { start: { line: 2 } }, 3: { start: { line: 5 } } },
        s: { 0: 1, 1: 0, 2: 3, 3: 0 },
      },
    }));
    const cov = loadLineCoverage(ROOT, file).get('backend/src/a.ts');
    assert.deepEqual([...cov.covered].sort(), [1, 2]);
    assert.deepEqual(uncoveredLines(cov), [5]);
  });

  it('formats line ranges', () => {
    assert.equal(formatRanges([7, 1, 2, 3, 5, 6, 10]), '1-3, 5-7, 10');
    assert.equal(formatRanges([]), '');
  });
});

describe('plan', () => {
  const cov = (exec, covered) => ({ executable: new Set(exec), covered: new Set(covered) });
  const baseline = {
    backend: {
      coverage: new Map([
        ['backend/src/features/todos/router.ts', cov([1, 2, 3, 4], [1, 2])],
        ['backend/src/features/todos/mappers.ts', cov([1, 2], [1, 2])],
        ['backend/src/features/todos/stats.ts', cov([1, 2, 3], [])],
        ['backend/src/features/todos/validators.ts', cov([1], [1])],
      ]),
      failingFiles: new Set(['backend/tests/validators.test.ts']),
    },
  };
  const exists = (p) => ['backend/tests/router.test.ts', 'backend/tests/validators.test.ts', 'backend/tests/old.test.ts'].includes(p);

  it('maps sources to the conventional test path', () => {
    assert.equal(testPathFor('backend/src/features/todos/router.ts'), 'backend/tests/router.test.ts');
    assert.equal(testPathFor('frontend/src/lib/http.ts'), 'frontend/src/lib/http.test.ts');
    assert.equal(testPathFor('frontend/src/App.tsx'), 'frontend/src/App.test.tsx');
  });

  it('decides each changed file from the diff and the baseline coverage', () => {
    const files = [
      { status: 'M', path: 'backend/src/features/todos/router.ts' },
      { status: 'M', path: 'backend/src/features/todos/mappers.ts' },
      { status: 'A', path: 'backend/src/features/todos/stats.ts' },
      { status: 'M', path: 'backend/src/features/todos/validators.ts' },
      { status: 'M', path: 'backend/src/features/todos/types.ts' },
      { status: 'D', path: 'backend/src/old.ts' },
      { status: 'M', path: 'backend/tests/router.test.ts' },
      { status: 'M', path: 'README.md' },
    ];
    const added = new Map([
      ['backend/src/features/todos/router.ts', [2, 3, 4]],
      ['backend/src/features/todos/mappers.ts', [1, 2]],
      ['backend/src/features/todos/stats.ts', [1, 2, 3]],
      ['backend/src/features/todos/validators.ts', [1]],
    ]);
    const { targets, noops } = planPullRequest({ files, added, baseline, exists, maxTargets: 8 });
    const byPath = Object.fromEntries(targets.map((t) => [t.path, t]));
    assert.equal(byPath['backend/src/features/todos/validators.ts'].action, 'repair-existing');
    assert.equal(targets[0].path, 'backend/src/features/todos/validators.ts', 'repairs come first');
    assert.equal(byPath['backend/src/features/todos/stats.ts'].action, 'write');
    assert.deepEqual(byPath['backend/src/features/todos/stats.ts'].linesToCover, [1, 2, 3]);
    assert.equal(byPath['backend/src/features/todos/router.ts'].action, 'update');
    assert.deepEqual(byPath['backend/src/features/todos/router.ts'].linesToCover, [3, 4]);
    const reasons = Object.fromEntries(noops.map((n) => [n.path, n.reason]));
    assert.match(reasons['backend/src/features/todos/mappers.ts'], /already covered/);
    assert.match(reasons['backend/src/features/todos/types.ts'], /no unit-test surface/);
    assert.match(reasons['backend/src/old.ts'], /deleted/);
    assert.match(reasons['backend/tests/router.test.ts'], /test file changed/);
    assert.match(reasons['README.md'], /outside/);
  });

  it('gives a new file its own tests even when other tests already execute it', () => {
    const covered = { backend: { coverage: new Map([['backend/src/features/todos/helper.ts', cov([1, 2], [1, 2])]]), failingFiles: new Set() } };
    const files = [{ status: 'A', path: 'backend/src/features/todos/helper.ts' }];
    const added = new Map([['backend/src/features/todos/helper.ts', [1, 2]]]);
    const { targets } = planPullRequest({ files, added, baseline: covered, exists: () => false, maxTargets: 8 });
    assert.equal(targets[0].action, 'write');
    assert.match(targets[0].reason, /new file/);
    assert.deepEqual(targets[0].linesToCover, [1, 2]);
    const modified = planPullRequest({ files: [{ ...files[0], status: 'M' }], added, baseline: covered, exists: () => false, maxTargets: 8 });
    assert.equal(modified.targets.length, 0, 'a modified, already covered file stays a noop');
  });

  it('caps the number of targets and reports the overflow', () => {
    const files = [
      { status: 'A', path: 'backend/src/features/todos/stats.ts' },
      { status: 'M', path: 'backend/src/features/todos/router.ts' },
    ];
    const added = new Map([
      ['backend/src/features/todos/stats.ts', [1, 2, 3]],
      ['backend/src/features/todos/router.ts', [3, 4]],
    ]);
    const { targets, noops } = planPullRequest({ files, added, baseline: { backend: { ...baseline.backend, failingFiles: new Set() } }, exists, maxTargets: 1 });
    assert.deepEqual(targets.map((t) => t.path), ['backend/src/features/todos/stats.ts']);
    assert.match(noops[0].reason, /over the target limit/);
  });

  it('bootstraps files below the threshold, honoring the skip list', () => {
    const { targets, noops } = planBootstrap({ baseline, exists, maxTargets: 8, threshold: 80, skip: ['backend/src/features/todos/stats.ts'] });
    assert.deepEqual(targets.map((t) => t.path).sort(), ['backend/src/features/todos/router.ts', 'backend/src/features/todos/validators.ts']);
    assert.equal(noops[0].reason, 'skipped by configuration');
  });
});

describe('static test checks', () => {
  const source = `
import { describe, it, expect, vi } from 'vitest'
import { thing } from '../src/thing.ts'
vi.mock('../src/dep.ts', () => ({}))
describe('thing', () => {
  it('works', () => { expect(thing()).toBe(1) })
  it.each([1, 2])('handles %s', (n) => { expect(n).toBeTruthy() })
  it('forgets to assert', () => { thing() })
  it.only('focused', () => { expect(1).toBe(1) })
})`;

  it('extracts titles including each and focused tests', () => {
    assert.deepEqual(extractTitles(source).sort(), ['focused', 'forgets to assert', 'handles %s', 'thing', 'works']);
  });

  it('finds focus, skip, and type escape markers', () => {
    assert.deepEqual(findDisallowedMarkers(source), ['.only']);
    assert.deepEqual(findDisallowedMarkers('it.skip("x", () => {}); const a = b as any; // @ts-ignore'), ['.skip', '@ts-ignore', 'as any']);
    assert.deepEqual(findDisallowedMarkers('const y = x as unknown as Foo'), []);
  });

  it('finds test blocks without assertions', () => {
    assert.deepEqual(blocksWithoutExpect(source), ['forgets to assert']);
  });

  it('collects import specifiers from imports and mocks', () => {
    assert.deepEqual(importSpecifiers(source).sort(), ['../src/dep.ts', '../src/thing.ts', 'vitest']);
  });

  it('lists assertions that disappeared', () => {
    assert.deepEqual(removedAssertionLines('expect(a).toBe(1)\nexpect(b).toBe(2)', 'expect(a).toBe(1)'), ['expect(b).toBe(2)']);
    assert.deepEqual(removedAssertionLines(null, 'x'), []);
  });
});

describe('task packet', () => {
  it('validates the author result shape', () => {
    assert.deepEqual(validateResult({}), { cases: [], notCovered: [], suspectedDefects: [], modifiedExistingAssertions: [] });
    assert.throws(() => validateResult([]), /JSON object/);
    assert.throws(() => validateResult({ suspectedDefects: ['text'] }), /suspectedDefects/);
  });

  it('renders the same prompt for every driver with the write allowlist and feedback', () => {
    mkdirSync(join(ROOT, 'backend', 'tests'), { recursive: true });
    writeFileSync(join(ROOT, 'backend', 'tests', 'router.test.ts'), "it('lists tasks', () => { expect(1).toBe(1) })");
    const target = {
      id: 't1', path: 'backend/src/features/todos/stats.ts', side: 'backend', action: 'write', reason: 'no test file yet',
      testPath: 'backend/tests/stats.test.ts', changedLines: [1, 2, 3], linesToCover: [2, 3], attempts: 2, repairs: 1, toolRuns: 0,
      feedback: { gate: 'G4', class: 'assertion', message: '1 failing test(s)', failures: [{ title: 'counts', message: 'expected 1 to be 2' }] },
    };
    const { packet, prompt } = renderTaskPacket({ root: ROOT, state: { mode: 'pr' }, target, budgets: loadConfig({}).budgets });
    assert.deepEqual(packet.writeAllowlist, ['backend/tests/stats.test.ts']);
    assert.equal(packet.styleReference, 'backend/tests/router.test.ts');
    assert.deepEqual(packet.skills.map((s) => s.name), ['diff-test-planning', 'backend-unit-tests', 'test-failure-triage']);
    assert.match(prompt, /Lines to cover: 2-3/);
    assert.match(prompt, /Gate G4 failed \(assertion\)/);
    assert.match(prompt, /uta tool run-tests --target t1/);
  });
});

describe('state', () => {
  it('refuses illegal transitions', () => {
    assert.throws(() => expectStatus({ id: 't1', status: 'pending' }, ['submitted'], 'gate'), /Cannot gate target t1/);
  });

  it('suggests the next command', () => {
    assert.match(nextStep({ stage: 'authoring', targets: [{ id: 't1', status: 'authoring', testPath: 'x' }] }), /uta submit --target t1/);
    assert.equal(nextStep({ stage: 'authoring', targets: [{ id: 't1', status: 'submitted' }] }), 'uta gate --target t1');
    assert.equal(nextStep({ stage: 'done', targets: [] }), null);
  });
});

describe('report', () => {
  const state = {
    mode: 'pr', head: 'abcdef1234', driver: 'sdk', stage: 'done', noops: [{ path: 'README.md', reason: 'outside frontend and backend' }],
    baseline: { backend: { tests: 48, linePercent: 33, failingTests: [] } },
    final: { backend: { status: 'pass', tests: 60, newTypeErrors: 0 } },
    targets: [
      { id: 't1', path: 'backend/src/a.ts', action: 'write', testPath: 'backend/tests/a.test.ts', status: 'accepted', outcome: 'accepted', linesToCover: [1, 2], coverage: { gained: 2 }, attempts: 1, repairs: 0, history: [], result: { modifiedExistingAssertions: [] }, reviewNotes: [] },
      { id: 't2', path: 'backend/src/b.ts', action: 'write', testPath: 'backend/tests/b.test.ts', status: 'rejected', outcome: 'suspected defect', linesToCover: [1], attempts: 1, repairs: 0, history: [], result: { suspectedDefects: [{ test: 'counts overdue', reason: 'completed tasks are counted' }] }, defectFailures: [{ message: 'expected 2 to be 1\nstack' }] },
    ],
  };

  it('uses literal verification wording', () => {
    assert.equal(verificationLine(state), 'Tests passed');
    assert.equal(verificationLine({ ...state, final: { backend: { status: 'fail', newTypeErrors: 0 } } }), 'Tests failed');
    assert.match(verificationLine({ final: {} }), /^Tests were not run/);
  });

  it('renders the sticky marker, decisions, and suspected defects', () => {
    const body = renderReport(state);
    assert.ok(body.startsWith('<!-- taskly-unit-test-agent -->'));
    assert.match(body, /Accepted: 1 of 2 target\(s\)\. Tests passed\./);
    assert.match(body, /\| `backend\/src\/a.ts` \| write \| `backend\/tests\/a.test.ts` \| accepted \| 2\/2 target lines \|/);
    assert.match(body, /counts overdue\. completed tasks are counted/);
    assert.match(body, /failing assertion: expected 2 to be 1$/m);
  });
});

describe('publish patch validation', async () => {
  const { validatePatch } = await import('../src/publish.mjs');
  const newFile = (path) => [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    "+it('x', () => expect(1).toBe(1))",
  ].join('\n');

  it('accepts new and modified allowlisted test files', () => {
    const modified = ['diff --git a/backend/tests/router.test.ts b/backend/tests/router.test.ts', 'index 1..2 100644', '--- a/backend/tests/router.test.ts', '+++ b/backend/tests/router.test.ts', '@@ -1 +1,2 @@', '+x'].join('\n');
    assert.deepEqual(validatePatch(`${newFile('frontend/src/lib/http.test.ts')}\n${modified}\n`), ['frontend/src/lib/http.test.ts', 'backend/tests/router.test.ts']);
    assert.deepEqual(validatePatch(''), []);
  });

  it('rejects production paths, renames, deletions, modes, and binaries', () => {
    assert.throws(() => validatePatch(newFile('backend/src/factory.ts')), /outside the test allowlist/);
    assert.throws(() => validatePatch(newFile('.github/workflows/ci.test.ts')), /outside the test allowlist/);
    assert.throws(() => validatePatch(`${newFile('backend/tests/a.test.ts')}\ndiff --git a/backend/tests/b.test.ts b/backend/tests/b.test.ts\ndeleted file mode 100644`), /deleted file mode/);
    assert.throws(() => validatePatch('diff --git a/backend/tests/a.test.ts b/backend/tests/c.test.ts\nrename from backend/tests/a.test.ts'), /unexpected diff header|rename from/);
    assert.throws(() => validatePatch(newFile('backend/tests/a.test.ts').replace('new file mode 100644', 'new file mode 120000')), /unexpected file mode/);
    assert.throws(() => validatePatch(`${newFile('backend/tests/a.test.ts')}\nGIT binary patch`), /binary/);
    assert.throws(() => validatePatch('--- /dev/null\n+++ b/backend/src/sneaky.ts\n@@ -0,0 +1 @@\n+x'), /without diff header/);
  });
});
