import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ensureDir, runNode } from './sandbox.mjs';
import { toRepoRelative } from './guard.mjs';

const VITEST = 'node_modules/vitest/vitest.mjs';
const TSC = 'node_modules/typescript/bin/tsc';

/** Path from the package directory to `abs`, POSIX separators. */
function fromPackage(root, side, abs) {
  return relative(join(root, side), abs).split(sep).join('/');
}

/** Package-relative path of a repo-relative path (`backend/tests/x.test.ts` -> `tests/x.test.ts`). */
export function packagePath(side, repoRel) {
  return repoRel.startsWith(`${side}/`) ? repoRel.slice(side.length + 1) : repoRel;
}

/**
 * Keep the useful head of a failure message and drop framework stack frames.
 * @param {string} message
 */
export function trimFailure(message) {
  const lines = String(message).split(/\r?\n/).filter((line) => !/node_modules[\\/]/.test(line));
  const text = lines.join('\n').trim();
  return text.length > 1500 ? `${text.slice(0, 1500)}\n[truncated]` : text;
}

/**
 * Vitest's JSON reporter replaces the message of a timed-out test with STACK_TRACE_ERROR.
 * Restore a message the author can act on.
 * @param {string} message
 * @param {number} [durationMs]
 */
export function explainFailure(message, durationMs) {
  if (!/^Error: STACK_TRACE_ERROR/.test(message)) return message;
  const after = durationMs ? ` after ${Math.round(durationMs)} ms` : '';
  return `Test timed out${after}: an awaited promise never settled, fake timers were not advanced, or the test is too slow.`;
}

/** @param {string} message */
export function classifyFailure(message) {
  if (/Test timed out|timed out in \d+ms|STACK_TRACE_ERROR/i.test(message)) return 'timeout';
  if (/AssertionError|expected .+ to |toHaveBeenCalled|toEqual|toBe\(/i.test(message)) return 'assertion';
  return 'runtime';
}

/**
 * Run Vitest with the JSON reporter.
 * @param {{
 *   root: string, side: 'frontend' | 'backend', files?: string[], outDir: string,
 *   coverageInclude?: string | null, shuffle?: boolean, config: import('./config.mjs').Config
 * }} opts files and coverageInclude are repo-relative
 */
export async function runVitest({ root, side, files = [], outDir, coverageInclude = null, shuffle = false, config }) {
  rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  const reportFile = join(outDir, 'vitest.json');
  const covDir = join(outDir, 'coverage');
  const args = [VITEST, 'run', ...files.map((f) => packagePath(side, f)), '--reporter=json', `--outputFile=${fromPackage(root, side, reportFile)}`];
  if (shuffle) args.push('--sequence.shuffle');
  if (coverageInclude !== null) {
    // Project coverage thresholds may fail the exit code of a scoped run; the JSON report,
    // not the exit code, decides pass/fail below.
    // reportOnFailure: a baseline with failing tests (a PR that broke them) still needs coverage.
    // coverage.all: new modules that no test imports yet still appear in the map (otherwise the
    // planner treats them as "no unit-test surface" and skips a write target).
    args.push('--coverage.enabled', '--coverage.reportOnFailure', '--coverage.reporter=json', `--coverage.reportsDirectory=${fromPackage(root, side, covDir)}`);
    if (coverageInclude === 'all') args.push('--coverage.all');
    else args.push(`--coverage.include=${packagePath(side, coverageInclude)}`);
  }
  const proc = await runNode({ root, side, args, config });
  const coverageFile = join(covDir, 'coverage-final.json');
  const base = {
    command: `node ${args.join(' ')}`,
    exitCode: proc.exitCode,
    durationMs: proc.durationMs,
    coverageFile: existsSync(coverageFile) ? coverageFile : null,
  };
  if (proc.timedOut) {
    return { ...base, status: 'timeout', numTests: 0, failures: [], stderrTail: proc.stderr.slice(-2000) };
  }
  if (!existsSync(reportFile)) {
    return { ...base, status: 'error', numTests: 0, failures: [], stderrTail: (proc.stderr || proc.stdout).slice(-2000) };
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const failures = [];
  for (const suite of report.testResults ?? []) {
    const file = toRepoRelative(root, suite.name) ?? suite.name;
    if (suite.status === 'failed' && !(suite.assertionResults ?? []).some((a) => a.status === 'failed')) {
      const message = trimFailure(suite.message || 'test file failed to load');
      failures.push({ file, title: '(file)', message, class: 'runtime' });
    }
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'failed') continue;
      const message = explainFailure(trimFailure((a.failureMessages ?? []).join('\n')), a.duration);
      failures.push({ file, title: a.fullName, message, class: classifyFailure(message) });
    }
  }
  const numTests = report.numTotalTests ?? 0;
  const status = failures.length ? 'fail' : numTests > 0 ? 'pass' : 'error';
  return {
    ...base,
    status,
    numTests,
    failures,
    stderrTail: status === 'error' ? (proc.stderr || proc.stdout).slice(-2000) : '',
  };
}

/**
 * Typecheck a package. Errors are returned with repo-relative paths.
 * @param {{ root: string, side: 'frontend' | 'backend', config: import('./config.mjs').Config }} opts
 */
export async function runTsc({ root, side, config }) {
  const proc = await runNode({ root, side, args: [TSC, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], config });
  const errors = [];
  for (const line of proc.stdout.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const file = `${side}/${m[1].replaceAll('\\', '/')}`;
    errors.push({ file, line: Number(m[2]), code: m[4], message: m[5] });
  }
  const failedToRun = proc.exitCode !== 0 && errors.length === 0;
  return { exitCode: proc.exitCode, errors, failedToRun, stderrTail: failedToRun ? (proc.stderr || proc.stdout).slice(-2000) : '' };
}

/** Stable identity of a typecheck error, independent of line shifts elsewhere. */
export function tscKey(error) {
  return `${error.file}|${error.code}|${error.message}`;
}
