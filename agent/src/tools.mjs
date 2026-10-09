import { join } from 'node:path';
import { formatRanges, loadLineCoverage } from './coverage.mjs';
import { HarnessError } from './lib/errors.mjs';
import { buildChangeContext } from './packet.mjs';
import { runVitest } from './runner.mjs';
import { expectStatus, getTarget, saveRun, targetDir } from './state.mjs';

/**
 * Author tools. One implementation, exposed to the SDK agent through MCP and to
 * external drivers through `uta tool ...`. Tools take a target id, never a free path.
 */

export function toolChangeContext({ root, state, targetId }) {
  const target = getTarget(state, targetId);
  return buildChangeContext(root, state, target);
}

export async function toolRunTests({ root, state, targetId, config }) {
  const target = getTarget(state, targetId);
  expectStatus(target, ['authoring'], 'run tests for');
  if (target.toolRuns >= config.budgets.maxToolRuns) {
    throw new HarnessError('budget_exhausted', `run_tests budget used up for ${target.id} (${config.budgets.maxToolRuns} per attempt). Finish and submit; the host verifies anyway.`);
  }
  target.toolRuns += 1;
  saveRun(root, state);
  const outDir = join(targetDir(root, state.runId, target.id), `attempt-${target.attempts}`, `tool-run-${target.toolRuns}`);
  const run = await runVitest({ root, side: target.side, files: [target.testPath], outDir, coverageInclude: target.path, config });
  target.lastToolCoverage = run.coverageFile;
  saveRun(root, state);
  return {
    status: run.status,
    numTests: run.numTests,
    failures: run.failures.slice(0, 10),
    durationMs: run.durationMs,
    runsLeft: config.budgets.maxToolRuns - target.toolRuns,
    ...(run.status === 'error' ? { output: run.stderrTail } : {}),
  };
}

export function toolCoverage({ root, state, targetId }) {
  const target = getTarget(state, targetId);
  if (!target.lastToolCoverage) {
    return { source: target.path, note: 'no run yet in this attempt; showing the baseline', linesToCover: formatRanges(target.linesToCover) };
  }
  const cov = loadLineCoverage(root, target.lastToolCoverage).get(target.path);
  const covered = new Set(cov?.covered ?? []);
  const stillUncovered = target.linesToCover.filter((l) => !covered.has(l));
  return {
    source: target.path,
    linesToCover: formatRanges(target.linesToCover),
    nowCovered: formatRanges(target.linesToCover.filter((l) => covered.has(l))),
    stillUncovered: formatRanges(stillUncovered),
  };
}
