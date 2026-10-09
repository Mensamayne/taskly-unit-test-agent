import { uncoveredLines } from './coverage.mjs';

/** @typedef {'frontend' | 'backend'} Side */

/** @param {string} path */
export function sideOf(path) {
  if (path.startsWith('frontend/')) return 'frontend';
  if (path.startsWith('backend/')) return 'backend';
  return null;
}

/** @param {string} path */
export function isTestFile(path) {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(path) || path.startsWith('backend/tests/');
}

/**
 * Conventional test path for a source file, following the repository layout:
 * backend tests are flat in `backend/tests/`, frontend tests sit beside the source.
 * @param {string} path
 */
export function testPathFor(path) {
  if (path.startsWith('backend/src/')) {
    const name = path.split('/').pop().replace(/\.ts$/, '');
    return `backend/tests/${name}.test.ts`;
  }
  if (path.startsWith('frontend/src/')) return path.replace(/\.(tsx?)$/, '.test.$1');
  return null;
}

/**
 * @typedef {{
 *   id: string, path: string, side: Side, action: 'write' | 'update' | 'repair-existing',
 *   reason: string, testPath: string, changedLines: number[], linesToCover: number[], priority: number
 * }} PlannedTarget
 * @typedef {{ path: string, reason: string, note?: string }} PlannedNoop
 * @typedef {{ coverage: Map<string, import('./coverage.mjs').LineCoverage>, failingFiles: Set<string> }} SideBaseline
 */

function finalize(candidates, noops, maxTargets) {
  candidates.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
  // Backend tests are flat, so two sources with the same file name map to one test path.
  // Only the first keeps it; two authors writing the same file would overwrite each other.
  const owner = new Map();
  const unique = [];
  for (const c of candidates) {
    if (owner.has(c.testPath)) {
      noops.push({ path: c.path, reason: `its test path ${c.testPath} is already used by ${owner.get(c.testPath)} in this run` });
      continue;
    }
    owner.set(c.testPath, c.path);
    unique.push(c);
  }
  const targets = unique.slice(0, maxTargets).map((t, i) => ({ id: `t${i + 1}`, ...t }));
  for (const t of unique.slice(maxTargets)) noops.push({ path: t.path, reason: `over the target limit (${maxTargets})` });
  return { targets, noops };
}

function actionFor(testPath, failingFiles, exists) {
  if (failingFiles.has(testPath)) return { action: 'repair-existing', reason: 'existing tests for this file fail or do not compile on the head commit' };
  if (exists(testPath)) return { action: 'update', reason: 'test file exists; add cases for the uncovered lines' };
  return { action: 'write', reason: 'no test file yet' };
}

/**
 * Pull request mode: decide per changed file from the diff and the baseline coverage.
 * The LLM is never asked whether a file needs tests.
 * @param {{
 *   files: Array<{ status: string, path: string }>,
 *   added: Map<string, number[]>,
 *   baseline: Partial<Record<Side, SideBaseline>>,
 *   exists: (repoRelPath: string) => boolean,
 *   maxTargets: number,
 * }} input
 */
export function planPullRequest({ files, added, baseline, exists, maxTargets }) {
  /** @type {Omit<PlannedTarget, 'id'>[]} */
  const candidates = [];
  /** @type {PlannedNoop[]} */
  const noops = [];
  for (const file of files) {
    const { path, status } = file;
    const side = sideOf(path);
    if (!side) {
      noops.push({ path, reason: 'outside frontend and backend' });
      continue;
    }
    if (isTestFile(path)) {
      noops.push({ path, reason: 'test file changed by the pull request' });
      continue;
    }
    const testPath = testPathFor(path);
    if (status === 'D') {
      const note = testPath && exists(testPath) ? `orphaned test file left in place: ${testPath}` : undefined;
      noops.push({ path, reason: 'file deleted', note });
      continue;
    }
    const cov = baseline[side]?.coverage.get(path);
    if (!cov || !testPath) {
      noops.push({ path, reason: 'no unit-test surface (not in the coverage scope)' });
      continue;
    }
    const failingFiles = baseline[side].failingFiles;
    const { action, reason } = actionFor(testPath, failingFiles, exists);
    const changed = (added.get(path) ?? []).filter((l) => cov.executable.has(l));
    if (action === 'repair-existing') {
      candidates.push({ path, side, action, reason, testPath, changedLines: changed, linesToCover: changed.filter((l) => !cov.covered.has(l)), priority: 1_000_000 });
      continue;
    }
    if (!changed.length) {
      noops.push({ path, reason: 'no executable lines changed' });
      continue;
    }
    // A new module gets its own unit tests even when other tests happen to execute it:
    // indirect coverage (for example a router test calling a helper) is not a test of the unit.
    if (status === 'A' && action === 'write') {
      candidates.push({ path, side, action, reason: 'new file without its own test file', testPath, changedLines: changed, linesToCover: changed, priority: changed.length });
      continue;
    }
    const uncovered = changed.filter((l) => !cov.covered.has(l));
    if (!uncovered.length) {
      noops.push({ path, reason: 'changed lines already covered by passing tests' });
      continue;
    }
    candidates.push({ path, side, action, reason, testPath, changedLines: changed, linesToCover: uncovered, priority: uncovered.length });
  }
  return finalize(candidates, noops, maxTargets);
}

/**
 * Bootstrap mode: every file in the coverage scope below the line threshold.
 * @param {{
 *   baseline: Partial<Record<Side, SideBaseline>>,
 *   exists: (repoRelPath: string) => boolean,
 *   maxTargets: number, threshold: number, skip: string[],
 * }} input
 */
export function planBootstrap({ baseline, exists, maxTargets, threshold, skip }) {
  const candidates = [];
  const noops = [];
  for (const [side, data] of Object.entries(baseline)) {
    for (const [path, cov] of data.coverage) {
      if (skip.includes(path)) {
        noops.push({ path, reason: 'skipped by configuration' });
        continue;
      }
      const testPath = testPathFor(path);
      const uncovered = uncoveredLines(cov);
      const pct = cov.executable.size ? (100 * cov.covered.size) / cov.executable.size : 100;
      if (!testPath) continue;
      const { action, reason } = actionFor(testPath, data.failingFiles, exists);
      if (action !== 'repair-existing' && pct >= threshold) continue;
      candidates.push({
        path, side: /** @type {Side} */ (side), action,
        reason: action === 'repair-existing' ? reason : `line coverage ${pct.toFixed(0)}% is below ${threshold}%; ${reason}`,
        testPath, changedLines: [], linesToCover: uncovered,
        priority: action === 'repair-existing' ? 1_000_000 : uncovered.length,
      });
    }
  }
  return finalize(candidates, noops, maxTargets);
}
