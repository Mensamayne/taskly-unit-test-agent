import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linePercent, loadLineCoverage } from './coverage.mjs';
import { runGates } from './gates.mjs';
import { HarnessError } from './lib/errors.mjs';
import { runCommand } from './lib/exec.mjs';
import { addedLines, changedFiles, commitAuthorEmail, fileDiff, resolveCommit, statusEntries } from './lib/git.mjs';
import { renderTaskPacket, validateResult } from './packet.mjs';
import { planBootstrap, planPullRequest } from './plan.mjs';
import { writeReport } from './report.mjs';
import { runTsc, runVitest, tscKey } from './runner.mjs';
import { ensureDir } from './sandbox.mjs';
import { activeMarker, clearActive, expectStatus, getTarget, newRunId, runDir, saveRun, setActive, targetDir } from './state.mjs';
import { fileHash, readOptional, restoreFile, revertSideEffects, takeSnapshot } from './workspace.mjs';

const SIDES = /** @type {const} */ (['backend', 'frontend']);

/** S0 preflight. Returns { skip: string } when the run should end quietly. */
async function preflight({ root, mode, base, head, driver, config }) {
  if (driver.kind === 'external' && config.inCi) {
    throw new HarnessError('external_in_ci', 'The external driver is for local development and is refused in CI.');
  }
  if (activeMarker(root)) {
    throw new HarnessError('run_active', 'Another run is waiting for an author. Finish it or run `uta abort`.');
  }
  for (const side of SIDES) {
    for (const bin of ['node_modules/vitest/vitest.mjs', 'node_modules/typescript/bin/tsc']) {
      if (!existsSync(join(root, side, bin))) throw new HarnessError('deps_missing', `${side}/${bin} not found. Run \`npm ci\` in ${side}/.`);
    }
  }
  if (config.sandbox === 'docker') {
    const docker = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
    if (docker.exitCode !== 0) throw new HarnessError('docker_missing', 'TEST_SANDBOX=docker but the Docker daemon is not reachable.');
  }
  const headSha = await resolveCommit(root, head);
  const checkedOut = await resolveCommit(root, 'HEAD');
  if (headSha !== checkedOut) throw new HarnessError('head_mismatch', `--head ${head} (${headSha.slice(0, 7)}) is not the checked-out commit (${checkedOut.slice(0, 7)}).`);
  const baseSha = mode === 'pr' ? await resolveCommit(root, base) : null;
  const dirty = await statusEntries(root, ['frontend', 'backend']);
  if (dirty.length) {
    throw new HarnessError('dirty_worktree', `frontend/ or backend/ has uncommitted changes: ${dirty.slice(0, 5).map((d) => d.path).join(', ')}`);
  }
  if (driver.kind !== 'external' && config.botEmails.includes(await commitAuthorEmail(root, headSha))) {
    return { headSha, baseSha, skip: 'head commit was pushed by the agent itself' };
  }
  return { headSha, baseSha, skip: null };
}

/** S2 baseline for one package: full suite with coverage, plus typecheck. */
async function baselineFor(root, runId, side, config) {
  const outDir = join(runDir(root, runId), 'baseline', side);
  const suite = await runVitest({ root, side, outDir, coverageInclude: 'all', config });
  if (suite.status === 'error' || suite.status === 'timeout' || !suite.coverageFile) {
    throw new HarnessError('baseline_failed', `Baseline test run for ${side} did not complete: ${suite.status}. ${suite.stderrTail}`);
  }
  const tsc = await runTsc({ root, side, config });
  if (tsc.failedToRun) throw new HarnessError('baseline_failed', `Baseline typecheck for ${side} did not run. ${tsc.stderrTail}`);
  const coverage = loadLineCoverage(root, suite.coverageFile);
  let executable = 0;
  let covered = 0;
  for (const c of coverage.values()) {
    executable += c.executable.size;
    covered += c.covered.size;
  }
  return {
    coverage,
    summary: {
      tests: suite.numTests,
      status: suite.status,
      linePercent: executable ? Math.round((1000 * covered) / executable) / 10 : 100,
      failingTests: suite.failures.map((f) => `${f.file}|${f.title}`),
      failingFiles: [...new Set(suite.failures.map((f) => f.file))],
      tscErrors: tsc.errors.map(tscKey),
      coverageFile: suite.coverageFile,
      files: Object.fromEntries([...coverage].map(([p, c]) => [p, Math.round(linePercent(c))])),
    },
  };
}

/**
 * S0-S3: preflight, collect, baseline, plan. Persists and returns the new run state.
 * @param {{ root: string, mode: 'pr' | 'bootstrap', base?: string, head?: string, sides?: string[], driver: { kind: string }, config: import('./config.mjs').Config }} opts
 */
export async function startRun({ root, mode, base, head = 'HEAD', sides, driver, config }) {
  const pre = await preflight({ root, mode, base, head, driver, config });
  const runId = newRunId(mode, pre.headSha);
  ensureDir(runDir(root, runId));
  const state = {
    version: 1, runId, mode, driver: driver.kind, base: pre.baseSha, head: pre.headSha,
    createdAt: new Date().toISOString(), stage: 'planning', baseline: {}, targets: [], noops: [], final: null, failure: null,
  };
  if (pre.skip) {
    Object.assign(state, { stage: 'skipped', skipReason: pre.skip });
    saveRun(root, state);
    return state;
  }

  let files = [];
  let added = new Map();
  let needed = sides?.length ? sides : [...SIDES];
  if (mode === 'pr') {
    files = await changedFiles(root, pre.baseSha, pre.headSha);
    added = await addedLines(root, pre.baseSha, pre.headSha);
    needed = SIDES.filter((s) => files.some((f) => f.path.startsWith(`${s}/src/`)));
  }
  state.changedFiles = files;

  /** @type {Record<string, import('./plan.mjs').SideBaseline>} */
  const forPlan = {};
  for (const side of needed) {
    const { coverage, summary } = await baselineFor(root, runId, side, config);
    state.baseline[side] = summary;
    forPlan[side] = { coverage, failingFiles: new Set(summary.failingFiles) };
  }

  const exists = (p) => existsSync(join(root, p));
  const plan = mode === 'pr'
    ? planPullRequest({ files, added, baseline: forPlan, exists, maxTargets: config.budgets.maxTargets })
    : planBootstrap({ baseline: forPlan, exists, maxTargets: config.budgets.maxTargets, threshold: config.budgets.bootstrapLineThreshold, skip: config.bootstrapSkip });
  state.noops = plan.noops;
  state.targets = plan.targets.map((t) => ({
    ...t, status: 'pending', attempts: 0, repairs: 0, toolRuns: 0, history: [], feedback: null, result: null, outcome: null,
  }));
  if (mode === 'pr') {
    // The author sees what changed, not only which lines: it decides whether an old assertion
    // is outdated by the change (repair-existing) or the change is a bug (suspected defect).
    for (const t of state.targets) t.diff = await fileDiff(root, pre.baseSha, pre.headSha, t.path);
  }
  state.stage = 'authoring';
  saveRun(root, state);
  return state;
}

/** Hand a target to the author: snapshot (first attempt only), packet files, active marker. */
async function issue(root, state, target, config) {
  if (target.attempts === 0) {
    target.snapshot = await takeSnapshot(root);
    target.originalTestContent = readOptional(root, target.testPath);
  }
  target.attempts += 1;
  target.toolRuns = 0;
  target.lastToolCoverage = null;
  target.status = 'authoring';
  const { packet, prompt } = renderTaskPacket({ root, state, target, budgets: config.budgets });
  const dir = ensureDir(join(targetDir(root, state.runId, target.id), `attempt-${target.attempts}`));
  writeFileSync(join(dir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(join(dir, 'prompt.md'), prompt);
  target.packetPath = join(dir, 'prompt.md');
  setActive(root, { runId: state.runId, targetId: target.id, allowedWrites: [target.testPath] });
  saveRun(root, state);
  return { packet, prompt, dir };
}

/** Record the author's self-report. */
export function submitResult(root, state, targetId, raw) {
  const target = getTarget(state, targetId);
  expectStatus(target, ['authoring'], 'submit');
  target.result = validateResult(raw);
  target.status = 'submitted';
  clearActive(root);
  saveRun(root, state);
  return target;
}

/**
 * A suspected-defect claim counts only if it names a test that actually failed on an assertion.
 * Otherwise an author could escape a repair by declaring any failure a bug in the source.
 * @param {Array<{ test: string }>} claims
 * @param {Array<{ title: string, class: string }>} failures
 */
export function matchedDefectClaims(claims, failures) {
  const norm = (t) => t.trim().toLowerCase();
  const failed = failures.filter((f) => f.class === 'assertion').map((f) => norm(f.title));
  return claims.filter((c) => {
    const claim = norm(c.test);
    return claim.length > 0 && failed.some((title) => title === claim || title.endsWith(claim) || claim.endsWith(title));
  });
}

/** Identity of a gate failure, used to detect repairs that make no progress. */
function failureSignature(gate) {
  return JSON.stringify([gate.gate, gate.class, gate.message, gate.failures.map((f) => `${f.title}|${f.message.split(/\r?\n/)[0]}`)]);
}

/** Reject a target and put its test file back as it was before the run. */
function reject(root, state, target, outcome) {
  restoreFile(root, target.testPath, target.originalTestContent);
  Object.assign(target, { status: 'rejected', outcome });
  saveRun(root, state);
}

/**
 * S5 gate + repair decision for one submitted target.
 * @returns {Promise<{ outcome: 'accepted' | 'repair' | 'rejected' | 'run-failed', gate: any }>}
 */
export async function gateTarget({ root, state, targetId, config }) {
  const target = getTarget(state, targetId);
  expectStatus(target, ['submitted'], 'gate');
  target.failedHashes ??= [];

  // Resubmitting a file that already failed cannot fix it, and with a flaky test it only
  // buys another roll of the dice. Reject without running anything.
  const hash = fileHash(root, target.testPath);
  if (target.failedHashes.includes(hash)) {
    const gate = { passed: false, gate: 'G0', class: 'no-progress', message: 'the test file is identical to an attempt that already failed', failures: [], checks: [] };
    target.history.push({ attempt: target.attempts, gate: gate.gate, class: gate.class, message: gate.message, checks: [], coverage: null });
    reject(root, state, target, 'rejected: resubmitted a test file that already failed');
    return { outcome: 'rejected', gate };
  }

  let gate = await runGates({ root, state, target, config });
  if (gate.class === 'infra') {
    // The environment failed, not the test. Try once more before giving up, without charging a repair.
    target.history.push({ attempt: target.attempts, gate: gate.gate, class: gate.class, message: gate.message, checks: gate.checks, coverage: null });
    gate = await runGates({ root, state, target, config });
  }
  target.history.push({ attempt: target.attempts, gate: gate.gate, class: gate.class, message: gate.message, checks: gate.checks, coverage: gate.coverage ?? null });

  if (gate.passed) {
    Object.assign(target, { status: 'accepted', outcome: 'accepted', coverage: gate.coverage, reviewNotes: gate.reviewNotes ?? [], feedback: null });
    saveRun(root, state);
    return { outcome: 'accepted', gate };
  }
  if (gate.fatal) {
    Object.assign(target, { status: 'rejected', outcome: `scope violation: ${gate.message}` });
    Object.assign(state, { stage: 'failed', failure: { code: 'scope_violation', target: target.id, message: gate.message } });
    clearActive(root);
    saveRun(root, state);
    return { outcome: 'run-failed', gate };
  }
  if (gate.class === 'infra') {
    reject(root, state, target, `not verified: infrastructure error at ${gate.gate} (${gate.message})`);
    return { outcome: 'rejected', gate };
  }
  target.failedHashes.push(hash);

  const claims = gate.class === 'assertion' ? matchedDefectClaims(target.result?.suspectedDefects ?? [], gate.failures) : [];
  if (claims.length) {
    target.defectClaims = claims;
    target.defectFailures = gate.failures.filter((f) => f.class === 'assertion').slice(0, 5);
    reject(root, state, target, 'suspected defect');
    return { outcome: 'rejected', gate };
  }

  const signature = failureSignature(gate);
  if (target.lastFailureSignature === signature) {
    reject(root, state, target, `rejected: no progress, attempt ${target.attempts} failed exactly like the previous one at ${gate.gate} (${gate.class})`);
    return { outcome: 'rejected', gate };
  }
  target.lastFailureSignature = signature;

  if (target.repairs < config.budgets.maxRepairs) {
    target.repairs += 1;
    const unmatched = (target.result?.suspectedDefects?.length ?? 0) > 0 && gate.class === 'assertion';
    target.feedback = {
      gate: gate.gate, class: gate.class, failures: gate.failures.slice(0, 5),
      message: unmatched ? `${gate.message}. The suspected defects you reported do not name a failing test, so they were not accepted.` : gate.message,
    };
    await issue(root, state, target, config);
    return { outcome: 'repair', gate };
  }
  reject(root, state, target, `rejected at ${gate.gate} (${gate.class}) after ${target.repairs} repair(s)`);
  return { outcome: 'rejected', gate };
}

/** S7: final verification of the resulting tree, then the report. */
async function finalize(root, state, config) {
  clearActive(root);
  const sides = Object.keys(state.baseline);
  state.final = {};
  for (const side of sides) {
    const suite = await runVitest({ root, side, outDir: join(runDir(root, state.runId), 'final', side), config });
    const accepted = state.targets.filter((t) => t.status === 'accepted').map((t) => t.testPath);
    const first = state.targets.find((t) => t.snapshot);
    const effects = first ? await revertSideEffects(root, first.snapshot, accepted) : { changed: [] };
    const tsc = await runTsc({ root, side, config });
    const known = new Set(state.baseline[side].tscErrors);
    state.final[side] = {
      status: suite.status,
      tests: suite.numTests,
      failures: suite.failures.slice(0, 10),
      newTypeErrors: tsc.errors.filter((e) => !known.has(tscKey(e))).length,
      sideEffects: effects.changed,
    };
    if (effects.changed.length) state.final[side].status = 'side-effect';
  }
  state.stage = 'done';
  saveRun(root, state);
  await writeReport(root, state);
  saveRun(root, state);
}

/**
 * Drive the run forward until it needs an external author, or finishes.
 * @param {{ root: string, state: any, driver: { kind: string, author?: Function }, config: import('./config.mjs').Config, log?: (msg: string) => void }} opts
 * @returns {Promise<{ outcome: 'awaiting-author' | 'done' | 'failed' | 'skipped', target?: any }>}
 */
export async function advance({ root, state, driver, config, log = () => {} }) {
  for (;;) {
    if (state.stage === 'skipped') return { outcome: 'skipped' };
    if (state.stage === 'failed') return { outcome: 'failed' };
    if (state.stage === 'done') return { outcome: 'done' };

    const submitted = state.targets.find((t) => t.status === 'submitted');
    if (submitted) {
      const res = await gateTarget({ root, state, targetId: submitted.id, config });
      log(`${submitted.id} ${submitted.path}: ${res.outcome}${res.gate.gate ? ` (${res.gate.gate} ${res.gate.class})` : ''}`);
      if (res.outcome === 'accepted' && driver.review) {
        try {
          submitted.reviewFindings = await driver.review({ root, state, target: submitted, config });
        } catch (err) {
          submitted.reviewFindings = null;
          log(`${submitted.id} review skipped: ${err.message}`);
        }
        saveRun(root, state);
      }
      continue;
    }

    let authoring = state.targets.find((t) => t.status === 'authoring');
    if (!authoring) {
      const next = state.targets.find((t) => t.status === 'pending');
      if (!next) {
        await finalize(root, state, config);
        continue;
      }
      await issue(root, state, next, config);
      authoring = next;
      log(`${next.id} ${next.path}: ${next.action}`);
    }
    if (driver.kind === 'external') return { outcome: 'awaiting-author', target: authoring };

    const blocked = driver.budgetBlock?.(state, authoring, config);
    if (blocked) {
      restoreFile(root, authoring.testPath, authoring.originalTestContent);
      Object.assign(authoring, { status: 'rejected', outcome: `not attempted: ${blocked}` });
      clearActive(root);
      saveRun(root, state);
      log(`${authoring.id} ${authoring.path}: ${authoring.outcome}`);
      continue;
    }
    const { packet, prompt } = renderTaskPacket({ root, state, target: authoring, budgets: config.budgets });
    let raw;
    try {
      raw = await driver.author({ root, state, target: authoring, packet, prompt, config });
    } catch (err) {
      // An author that cannot run (auth, network, API error) ends the run with a report, not a crash.
      abortRun(root, state, `author failed on ${authoring.id}: ${err.message}`, 'author_error');
      await writeReport(root, state);
      saveRun(root, state);
      log(`${authoring.id} ${authoring.path}: author error: ${err.message}`);
      return { outcome: 'failed' };
    }
    submitResult(root, state, authoring.id, raw);
  }
}

/** Abandon the current run: restore the target being authored and mark the run failed. */
export function abortRun(root, state, reason, code = 'aborted') {
  for (const t of state.targets) {
    if (t.status === 'authoring' || t.status === 'submitted') {
      if (t.attempts > 0) restoreFile(root, t.testPath, t.originalTestContent ?? null);
      Object.assign(t, { status: 'rejected', outcome: code === 'aborted' ? 'aborted' : 'author error' });
    }
  }
  for (const t of state.targets) {
    if (t.status === 'pending') Object.assign(t, { status: 'rejected', outcome: 'not attempted' });
  }
  Object.assign(state, { stage: 'failed', failure: { code, message: reason } });
  clearActive(root);
  saveRun(root, state);
}
