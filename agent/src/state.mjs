import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from './lib/errors.mjs';

/**
 * Run directory and checkpoint. Every CLI command loads state.json, checks that the
 * requested transition is legal, mutates, and saves atomically. This is what lets an
 * external driver (a person or another coding agent) run the flow step by step under the
 * same rules as the SDK driver.
 *
 * Target lifecycle: pending -> authoring -> submitted -> accepted | rejected
 *                                 ^                |
 *                                 +---- repair ----+
 */

export const TERMINAL = new Set(['accepted', 'rejected']);

export function runsRoot(root) {
  return join(root, '.uta-runs');
}

export function runDir(root, runId) {
  return join(runsRoot(root), runId);
}

export function targetDir(root, runId, targetId) {
  return join(runDir(root, runId), 'targets', targetId);
}

function writeJsonAtomic(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** @param {string} root @param {Record<string, any>} state */
export function saveRun(root, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(runDir(root, state.runId), 'state.json'), state);
  writeFileSync(join(runsRoot(root), 'latest'), state.runId);
}

/** @param {string} root @param {string} [runId] defaults to the latest run */
export function loadRun(root, runId) {
  const id = runId ?? (existsSync(join(runsRoot(root), 'latest')) ? readFileSync(join(runsRoot(root), 'latest'), 'utf8').trim() : null);
  if (!id) throw new HarnessError('no_run', 'No run found. Start one with `uta run`.');
  const file = join(runDir(root, id), 'state.json');
  if (!existsSync(file)) throw new HarnessError('no_run', `Run not found: ${id}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function newRunId(mode, headSha) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${mode}-${stamp}-${headSha.slice(0, 7)}`;
}

/** @param {Record<string, any>} state @param {string} targetId */
export function getTarget(state, targetId) {
  const target = state.targets.find((t) => t.id === targetId);
  if (!target) throw new HarnessError('unknown_target', `Unknown target: ${targetId}`);
  return target;
}

/**
 * Throw unless the target is in one of the expected states.
 * @param {Record<string, any>} target
 * @param {string[]} expected
 * @param {string} action
 */
export function expectStatus(target, expected, action) {
  if (!expected.includes(target.status)) {
    throw new HarnessError('illegal_transition', `Cannot ${action} target ${target.id} in status "${target.status}" (expected ${expected.join(' or ')}).`, {
      target: target.id,
      status: target.status,
    });
  }
}

/** Marker read by the write-time hook while a target is being authored. */
export function setActive(root, payload) {
  writeJsonAtomic(join(runsRoot(root), '.active'), payload);
}

export function clearActive(root) {
  rmSync(join(runsRoot(root), '.active'), { force: true });
}

export function activeMarker(root) {
  const file = join(runsRoot(root), '.active');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Next command a driver should call, for `uta status` and CLI hints. */
export function nextStep(state) {
  if (state.stage === 'done' || state.stage === 'failed' || state.stage === 'skipped') return null;
  const authoring = state.targets.find((t) => t.status === 'authoring');
  if (authoring) return `write ${authoring.testPath}, then: uta submit --target ${authoring.id} --result <file>`;
  const submitted = state.targets.find((t) => t.status === 'submitted');
  if (submitted) return `uta gate --target ${submitted.id}`;
  return 'uta resume';
}
