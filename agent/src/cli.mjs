#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createExternalDriver } from './author/external.mjs';
import { createStubDriver } from './author/stub.mjs';
import { loadConfig } from './config.mjs';
import { evaluateToolUse, readActiveMarker } from './guard.mjs';
import { HarnessError } from './lib/errors.mjs';
import { runCommand } from './lib/exec.mjs';
import { abortRun, advance, gateTarget, startRun, submitResult } from './pipeline.mjs';
import { writeReport } from './report.mjs';
import { getTarget, loadRun, nextStep, saveRun } from './state.mjs';
import { toolChangeContext, toolCoverage, toolRunTests } from './tools.mjs';

const EXIT = { ok: 0, error: 1, usage: 2, awaiting: 3, failed: 4 };

const USAGE = `uta: Taskly unit-test agent

  uta run --mode pr --base <ref> [--head <ref>] [--author sdk|external|stub] [--stub <file>] [--config-root <dir>]
  uta run --mode bootstrap [--sides backend,frontend] [--author ...]
  uta status [--run <id>]
  uta packet --target <id> [--json]
  uta tool change-context|run-tests|coverage --target <id>
  uta submit --target <id> --result <file|->
  uta gate --target <id>
  uta resume [--author ...] [--stub <file>]
  uta report
  uta abort [--reason <text>]
  uta hook                      (PreToolUse hook: reads the event JSON on stdin)

All commands print JSON on stdout. Exit codes: 0 ok, 1 error, 2 usage, 3 awaiting author, 4 run failed.`;

function parseArgs(argv) {
  const positional = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

function str(flags, key, required = false) {
  const value = flags[key];
  if (typeof value === 'string') return value;
  if (required) throw new HarnessError('usage', `Missing --${key}.`);
  return undefined;
}

async function repoRoot(flags) {
  if (typeof flags.root === 'string') return resolve(flags.root);
  const out = await runCommand('git', ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 });
  if (out.exitCode !== 0) throw new HarnessError('not_a_repo', 'Run uta inside the Taskly git repository.');
  return resolve(out.stdout.trim());
}

async function makeDriver(kind, flags, root) {
  if (kind === 'external') return createExternalDriver();
  if (kind === 'stub') return createStubDriver(resolve(str(flags, 'stub', true)));
  if (kind === 'sdk') {
    // Loaded on demand: the other drivers and the harness tests do not need the SDK installed.
    const { createSdkDriver } = await import('./author/sdk.mjs');
    return createSdkDriver({ configRoot: resolve(str(flags, 'config-root') ?? root) });
  }
  throw new HarnessError('usage', `Unknown --author ${kind}.`);
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const log = (msg) => process.stderr.write(`[uta] ${msg}\n`);

function summarize(state, outcome) {
  const awaiting = state.targets.find((t) => t.status === 'authoring');
  return {
    ok: outcome !== 'failed',
    runId: state.runId,
    outcome,
    stage: state.stage,
    targets: state.targets.map((t) => ({ id: t.id, path: t.path, action: t.action, status: t.status, outcome: t.outcome, attempts: t.attempts })),
    ...(awaiting ? { awaiting: { target: awaiting.id, testPath: awaiting.testPath, prompt: awaiting.packetPath } } : {}),
    ...(state.artifacts ? { artifacts: state.artifacts } : {}),
    ...(state.failure ? { failure: state.failure } : {}),
    next: nextStep(state),
  };
}

function exitFor(outcome) {
  if (outcome === 'awaiting-author') return EXIT.awaiting;
  if (outcome === 'failed') return EXIT.failed;
  return EXIT.ok;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, sub] = positional;
  if (!command || flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return command ? EXIT.ok : EXIT.usage;
  }
  const config = loadConfig();
  const root = await repoRoot(flags);

  switch (command) {
    case 'run': {
      const mode = str(flags, 'mode', true);
      if (mode !== 'pr' && mode !== 'bootstrap') throw new HarnessError('usage', '--mode must be pr or bootstrap.');
      const driver = await makeDriver(str(flags, 'author') ?? 'sdk', flags, root);
      const sides = str(flags, 'sides')?.split(',').map((s) => s.trim());
      const state = await startRun({ root, mode, base: str(flags, 'base', mode === 'pr'), head: str(flags, 'head') ?? 'HEAD', sides, driver, config });
      log(`run ${state.runId}: ${state.targets.length} target(s), ${state.noops.length} file(s) without action`);
      const { outcome } = await advance({ root, state, driver, config, log });
      print(summarize(state, outcome));
      return exitFor(outcome);
    }
    case 'resume': {
      const state = loadRun(root, str(flags, 'run'));
      const driver = await makeDriver(str(flags, 'author') ?? state.driver, flags, root);
      const { outcome } = await advance({ root, state, driver, config, log });
      print(summarize(state, outcome));
      return exitFor(outcome);
    }
    case 'status': {
      const state = loadRun(root, str(flags, 'run'));
      print({ ...summarize(state, state.stage), budgets: config.budgets });
      return EXIT.ok;
    }
    case 'packet': {
      const state = loadRun(root, str(flags, 'run'));
      const target = getTarget(state, str(flags, 'target', true));
      if (!target.packetPath) throw new HarnessError('no_packet', `Target ${target.id} has not been handed out yet.`);
      const file = flags.json ? target.packetPath.replace(/prompt\.md$/, 'packet.json') : target.packetPath;
      process.stdout.write(readFileSync(file, 'utf8'));
      return EXIT.ok;
    }
    case 'tool': {
      const state = loadRun(root, str(flags, 'run'));
      const targetId = str(flags, 'target', true);
      if (sub === 'change-context') print(toolChangeContext({ root, state, targetId }));
      else if (sub === 'run-tests') print(await toolRunTests({ root, state, targetId, config }));
      else if (sub === 'coverage') print(toolCoverage({ root, state, targetId }));
      else throw new HarnessError('usage', 'uta tool change-context|run-tests|coverage --target <id>');
      return EXIT.ok;
    }
    case 'submit': {
      const state = loadRun(root, str(flags, 'run'));
      const file = str(flags, 'result', true);
      const text = file === '-' ? await readStdin() : readFileSync(resolve(file), 'utf8');
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        throw new HarnessError('invalid_result', `Result is not valid JSON: ${err.message}`);
      }
      const target = submitResult(root, state, str(flags, 'target', true), raw);
      print({ ok: true, target: target.id, status: target.status, next: nextStep(state) });
      return EXIT.ok;
    }
    case 'gate': {
      const state = loadRun(root, str(flags, 'run'));
      const targetId = str(flags, 'target', true);
      const { outcome, gate } = await gateTarget({ root, state, targetId, config });
      const target = getTarget(state, targetId);
      print({
        ok: outcome !== 'run-failed',
        target: targetId,
        outcome,
        gate: gate.gate,
        class: gate.class,
        message: gate.message,
        failures: gate.failures.slice(0, 5),
        checks: gate.checks,
        coverage: gate.coverage ?? null,
        ...(outcome === 'repair' ? { prompt: target.packetPath, repairsLeft: config.budgets.maxRepairs - target.repairs } : {}),
        next: nextStep(state),
      });
      return outcome === 'run-failed' ? EXIT.failed : EXIT.ok;
    }
    case 'report': {
      const state = loadRun(root, str(flags, 'run'));
      if (state.stage !== 'done' && state.stage !== 'failed' && state.stage !== 'skipped') {
        throw new HarnessError('not_finished', `Run is still in stage "${state.stage}". Next: ${nextStep(state)}`);
      }
      await writeReport(root, state);
      saveRun(root, state);
      print({ ok: true, artifacts: state.artifacts });
      return EXIT.ok;
    }
    case 'abort': {
      const state = loadRun(root, str(flags, 'run'));
      abortRun(root, state, str(flags, 'reason') ?? 'aborted by the operator');
      await writeReport(root, state);
      saveRun(root, state);
      print({ ok: true, runId: state.runId, stage: state.stage });
      return EXIT.ok;
    }
    case 'hook': {
      const event = JSON.parse((await readStdin()) || '{}');
      const verdict = evaluateToolUse(root, event, readActiveMarker(root));
      if (verdict.decision === 'deny') {
        print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } });
      }
      return EXIT.ok;
    }
    default:
      throw new HarnessError('usage', `Unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const isUsage = err instanceof HarnessError && err.code === 'usage';
    print({ ok: false, error: { code: err.code ?? 'internal', message: err.message, ...(err.details ?? {}) } });
    if (!(err instanceof HarnessError)) process.stderr.write(`${err.stack}\n`);
    process.exitCode = isUsage ? EXIT.usage : EXIT.error;
  },
);
