import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadLineCoverage } from './coverage.mjs';
import { isWritablePath } from './guard.mjs';
import { packagePath, runTsc, runVitest, tscKey } from './runner.mjs';
import { runNode } from './sandbox.mjs';
import { targetDir } from './state.mjs';
import { blocksWithoutExpect, extractTitles, findDisallowedMarkers, removedAssertionLines, unresolvedImports, unstubbedRandomness } from './testfile.mjs';
import { changedSince, readOptional, revertSideEffects } from './workspace.mjs';

const PRETTIER = 'node_modules/prettier/bin/prettier.cjs';

/**
 * Acceptance gates G1-G7. The host runs them for every driver; nothing the author
 * claims is trusted. The first failing gate stops evaluation.
 *
 * Failure classes: scope, static, typecheck, runtime, assertion, timeout, no-gain, flaky,
 * pollution, side-effect (the author can fix these) and infra (the environment failed; not
 * charged to the author).
 *
 * Returns { passed, gate, class, message, failures, fatal, coverage, reviewNotes, checks }.
 */
export async function runGates({ root, state, target, config }) {
  const checks = [];
  const record = (gate, ok, detail) => checks.push({ gate, ok, detail });
  const fail = (gate, cls, message, extra = {}) => ({ passed: false, gate, class: cls, message, failures: [], fatal: false, checks, ...extra });
  const workDir = join(targetDir(root, state.runId, target.id), `attempt-${target.attempts}`, 'gates');
  const baseline = state.baseline[target.side];
  const timeoutMs = config.budgets.commandTimeoutMs;

  // Running tests must not change anything but the test file. Revert what a run changed and
  // fail the gate; a change that cannot be reverted (the file was already dirty) fails the run.
  const checkSideEffects = async (gate) => {
    const effects = await revertSideEffects(root, target.snapshot, [target.testPath]);
    if (!effects.changed.length) return null;
    record(gate, false, effects);
    const reverted = effects.restored.length ? ` Reverted: ${effects.restored.join(', ')}.` : '';
    return fail(gate, 'side-effect', `running the tests changed files outside the test file: ${effects.changed.join(', ')}.${reverted} Tests must not write to the repository.`, {
      fatal: effects.unrestorable.length > 0,
    });
  };
  const runFailure = (gate, run, defaultClass) => {
    if (run.status === 'timeout') return fail(gate, 'timeout', `the test run exceeded ${timeoutMs} ms and was stopped (an infinite loop or a hang outside a test)`);
    if (run.status === 'error') return fail(gate, 'infra', `vitest did not produce results: ${run.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ')}`);
    return fail(gate, run.failures[0]?.class ?? defaultClass, `${run.failures.length} failing test(s)`, { failures: run.failures });
  };

  // G1 scope: compare the whole worktree to the snapshot taken when the target was handed out.
  const changed = await changedSince(root, target.snapshot);
  const outside = changed.filter((p) => p !== target.testPath);
  if (outside.length) {
    record('G1', false, outside);
    return fail('G1', 'scope', `files outside the target were changed: ${outside.join(', ')}`, { fatal: true, outside });
  }
  if (!isWritablePath(target.testPath)) return fail('G1', 'scope', `test path is not writable: ${target.testPath}`, { fatal: true });
  if (readOptional(root, target.testPath) === null || !changed.includes(target.testPath)) {
    record('G1', false, 'test file not written');
    return fail('G1', 'static', `the test file ${target.testPath} was not written or not changed`);
  }
  record('G1', true, changed);

  // Deterministic post-processing: format with the package's own Prettier setup, so style is
  // never a reason for a repair round. A Prettier parse error means the file is not valid code.
  const prettier = join(root, target.side, PRETTIER);
  if (existsSync(prettier) && existsSync(join(root, target.side, '.prettierrc.json'))) {
    const fmt = await runNode({ root, side: target.side, args: [PRETTIER, '--write', packagePath(target.side, target.testPath)], config });
    if (fmt.exitCode !== 0) {
      record('format', false, fmt.stderr.slice(-1000));
      return fail('G2', 'static', `the file does not parse: ${fmt.stderr.trim().split('\n').slice(0, 5).join(' ')}`);
    }
    record('format', true);
  }
  const content = readOptional(root, target.testPath);

  // G2 static checks.
  const problems = [];
  const markers = findDisallowedMarkers(content);
  if (markers.length) problems.push(`disallowed markers: ${markers.join(', ')}`);
  const empty = blocksWithoutExpect(content);
  if (empty.length) problems.push(`tests without assertions: ${empty.map((t) => `"${t}"`).join(', ')}`);
  const before = target.originalTestContent;
  const lostTitles = before ? extractTitles(before).filter((t) => !extractTitles(content).includes(t)) : [];
  if (lostTitles.length) problems.push(`existing tests removed or renamed: ${lostTitles.map((t) => `"${t}"`).join(', ')}`);
  const unresolved = unresolvedImports(root, target.testPath, content);
  if (unresolved.length) problems.push(`imports that do not resolve (new dependencies are not allowed): ${unresolved.join(', ')}`);
  if (!extractTitles(content).length) problems.push('no tests found');
  const random = unstubbedRandomness(content);
  if (random.length) problems.push(`nondeterministic values without a stub: ${random.join(', ')} (stub them with vi.spyOn or use fixed values)`);
  if (problems.length) {
    record('G2', false, problems);
    return fail('G2', 'static', problems.join('; '));
  }
  record('G2', true);
  const reviewNotes = removedAssertionLines(before, content);

  // G3 typecheck: no new errors compared with the baseline.
  const tsc = await runTsc({ root, side: target.side, config });
  if (tsc.failedToRun) return fail('G3', 'infra', `tsc did not run: ${tsc.stderrTail}`);
  const known = new Set(baseline.tscErrors);
  const fresh = tsc.errors.filter((e) => !known.has(tscKey(e)));
  if (fresh.length) {
    record('G3', false, fresh);
    return fail('G3', 'typecheck', `${fresh.length} new type error(s)`, {
      failures: fresh.slice(0, 10).map((e) => ({ title: `${e.file}:${e.line}`, message: `${e.code}: ${e.message}`, class: 'typecheck' })),
    });
  }
  record('G3', true);

  // G4 pass (+ coverage for G6 in the same run).
  const first = await runVitest({
    root, side: target.side, files: [target.testPath], outDir: join(workDir, 'g4'),
    coverageInclude: target.path, config,
  });
  const afterG4 = await checkSideEffects('G4');
  if (afterG4) return afterG4;
  if (first.status !== 'pass') {
    record('G4', false, first.status);
    return runFailure('G4', first, 'runtime');
  }
  record('G4', true, `${first.numTests} tests`);

  // G6 value (evaluated before the slower G5/G7 so a useless file fails fast).
  let coverage = null;
  if (first.coverageFile) {
    const cov = loadLineCoverage(root, first.coverageFile).get(target.path);
    const covered = new Set(cov ? cov.covered : []);
    const gained = target.linesToCover.filter((l) => covered.has(l));
    coverage = { toCover: target.linesToCover.length, gained: gained.length, gainedLines: gained };
  }
  if (target.action !== 'repair-existing') {
    if (!coverage || coverage.gained === 0) {
      record('G6', false, coverage);
      return fail('G6', 'no-gain', `the tests cover none of the target lines (${target.linesToCover.length} to cover)`, { coverage });
    }
    record('G6', true, coverage);
  }

  // G5 stability: repeated runs in shuffled order.
  for (let i = 2; i <= config.budgets.stabilityRuns; i++) {
    const again = await runVitest({ root, side: target.side, files: [target.testPath], outDir: join(workDir, `g5-${i}`), shuffle: true, config });
    const afterG5 = await checkSideEffects('G5');
    if (afterG5) return afterG5;
    if (again.status === 'error') return runFailure('G5', again, 'flaky');
    if (again.status !== 'pass') {
      record('G5', false, `run ${i}: ${again.status}`);
      return fail('G5', 'flaky', `passed once but failed on repeat run ${i} (shuffled order)`, { failures: again.failures, coverage });
    }
  }
  record('G5', true, `${config.budgets.stabilityRuns} runs`);

  // G7 full package suite: no new failures compared with the baseline.
  const suite = await runVitest({ root, side: target.side, outDir: join(workDir, 'g7'), config });
  const knownFailing = new Set(baseline.failingTests);
  const afterG7 = await checkSideEffects('G7');
  if (afterG7) return afterG7;
  if (suite.status === 'error' || suite.status === 'timeout') return runFailure('G7', suite, 'pollution');
  const newFailures = suite.failures.filter((f) => !knownFailing.has(`${f.file}|${f.title}`));
  if (newFailures.length) {
    record('G7', false, newFailures);
    return fail('G7', 'pollution', `${newFailures.length} test(s) fail when the new file runs with the full suite`, { failures: newFailures, coverage });
  }
  record('G7', true, `${suite.numTests} tests in suite`);

  return { passed: true, gate: null, class: null, message: 'all gates passed', failures: [], fatal: false, checks, coverage, reviewNotes };
}
