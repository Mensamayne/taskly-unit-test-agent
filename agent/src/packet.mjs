import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatRanges } from './coverage.mjs';
import { HarnessError } from './lib/errors.mjs';
import { dirOf, extractTitles } from './testfile.mjs';
import { readOptional } from './workspace.mjs';

/**
 * The task packet is the single source of the author prompt. The SDK driver sends
 * `prompt` as the user message; the external driver writes the same text to disk.
 */

export const RESULT_EXAMPLE = {
  cases: ['returns 404 when the task does not exist'],
  notCovered: [{ what: 'process signal handling', why: 'needs a real server process' }],
  suspectedDefects: [{ test: 'counts only active overdue tasks', reason: 'stats.ts counts completed tasks as overdue' }],
  modifiedExistingAssertions: [{ test: 'creates tasks with defaults', reason: 'the PR changed the default priority to low' }],
};

const FIELDS = {
  cases: (v) => typeof v === 'string',
  notCovered: (v) => v && typeof v.what === 'string' && typeof v.why === 'string',
  suspectedDefects: (v) => v && typeof v.test === 'string' && typeof v.reason === 'string',
  modifiedExistingAssertions: (v) => v && typeof v.test === 'string' && typeof v.reason === 'string',
};

/**
 * Validate an author self-report. Missing arrays default to empty; wrong shapes are rejected.
 * @param {unknown} raw
 */
export function validateResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HarnessError('invalid_result', 'Result must be a JSON object.');
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const [key, check] of Object.entries(FIELDS)) {
    const value = /** @type {any} */ (raw)[key] ?? [];
    if (!Array.isArray(value) || !value.every(check)) {
      throw new HarnessError('invalid_result', `Result field "${key}" has the wrong shape. Example: ${JSON.stringify(RESULT_EXAMPLE[key])}`);
    }
    out[key] = value.slice(0, 50);
  }
  return out;
}

/**
 * Existing test file to imitate for style. When the target's own test file exists, that file
 * is the reference. Otherwise: frontend, the nearest test up the directory tree; backend (flat
 * tests), the test of another module from the same source directory, then any backend test.
 */
export function siblingTest(root, target) {
  if (existsSync(join(root, target.testPath))) return target.testPath;
  if (target.side === 'backend') {
    const srcDir = dirOf(target.path);
    const neighbours = existsSync(join(root, srcDir)) ? readdirSync(join(root, srcDir)).filter((f) => /\.ts$/.test(f)).sort() : [];
    for (const file of neighbours) {
      const candidate = `backend/tests/${file.replace(/\.ts$/, '.test.ts')}`;
      if (candidate !== target.testPath && existsSync(join(root, candidate))) return candidate;
    }
  }
  const dir = target.side === 'backend' ? 'backend/tests' : dirOf(target.testPath);
  const walk = [dir];
  if (target.side === 'frontend') {
    let d = dir;
    while (d.includes('/') && d !== 'frontend/src') {
      d = d.slice(0, d.lastIndexOf('/'));
      walk.push(d);
    }
  }
  for (const d of walk) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    const found = readdirSync(abs)
      .filter((f) => /\.test\.tsx?$/.test(f) && `${d}/${f}` !== target.testPath)
      .sort();
    if (found.length) return `${d}/${found[0]}`;
  }
  return null;
}

/**
 * Collapse failures that share the same first message line ("9 tests: No QueryClient set")
 * so one root cause does not crowd out the others.
 * @param {Array<{ title: string, message: string }>} failures
 */
export function groupFailures(failures) {
  const groups = new Map();
  for (const f of failures) {
    const key = String(f.message).split(/\r?\n/)[0];
    if (!groups.has(key)) groups.set(key, { titles: [], message: f.message });
    groups.get(key).titles.push(f.title);
  }
  return [...groups.values()].map((g) => ({
    label: g.titles.length === 1 ? g.titles[0] : `${g.titles.length} tests (${g.titles.slice(0, 3).map((t) => `"${t}"`).join(', ')}${g.titles.length > 3 ? ', ...' : ''})`,
    message: g.message,
  }));
}

export function skillsFor(target, hasFeedback) {
  const skills = ['diff-test-planning', target.side === 'backend' ? 'backend-unit-tests' : 'frontend-unit-tests'];
  if (hasFeedback || target.action === 'repair-existing') skills.push('test-failure-triage');
  return skills;
}

/** Structured change context (also returned by the get_change_context tool). */
export function buildChangeContext(root, state, target) {
  const testContent = readOptional(root, target.testPath);
  return {
    target: target.id,
    mode: state.mode,
    source: target.path,
    side: target.side,
    action: target.action,
    reason: target.reason,
    testPath: target.testPath,
    testFileExists: testContent !== null,
    changedLines: formatRanges(target.changedLines),
    linesToCover: formatRanges(target.linesToCover),
    existingTestTitles: testContent ? extractTitles(testContent) : [],
    styleReference: siblingTest(root, target),
    ...(target.diff ? { diff: target.diff } : {}),
  };
}

const ACTION_VERB = { write: 'Create', update: 'Extend', 'repair-existing': 'Repair' };

/**
 * @param {{ root: string, state: Record<string, any>, target: Record<string, any>, budgets: Record<string, number> }} input
 */
export function renderTaskPacket({ root, state, target, budgets }) {
  const ctx = buildChangeContext(root, state, target);
  const feedback = target.feedback ?? null;
  const skills = skillsFor(target, Boolean(feedback));
  const toolRunsLeft = Math.max(0, budgets.maxToolRuns - target.toolRuns);
  const packet = {
    ...ctx,
    attempt: target.attempts,
    repairsLeft: Math.max(0, budgets.maxRepairs - target.repairs),
    toolRunsLeft,
    skills: skills.map((name) => ({ name, path: `.claude/skills/${name}/SKILL.md` })),
    writeAllowlist: [target.testPath],
    feedback,
    resultExample: RESULT_EXAMPLE,
  };

  const lines = [];
  lines.push(`# Unit test task ${target.id}: ${ACTION_VERB[target.action]} tests for \`${target.path}\``, '');
  lines.push('You are the Taskly unit-test author. Work on this one target only.', '');
  lines.push('## Target', '');
  lines.push(`- Source: \`${target.path}\` (${target.side})`);
  lines.push(`- Test file: \`${target.testPath}\` (${ctx.testFileExists ? 'exists' : 'create it'}). This is the only file you may write.`);
  lines.push(`- Action: ${target.action}. Reason: ${target.reason}.`);
  if (state.mode === 'pr') lines.push(`- Changed executable lines in this pull request: ${ctx.changedLines || 'none'}`);
  if (target.action !== 'repair-existing') lines.push(`- Lines to cover: ${ctx.linesToCover}`);
  else if (ctx.linesToCover) lines.push(`- New lines not yet covered (cover them too if a unit test can): ${ctx.linesToCover}`);
  lines.push(`- Existing tests in the test file: ${ctx.existingTestTitles.length ? ctx.existingTestTitles.map((t) => `"${t}"`).join(', ') : 'none'}`);
  if (ctx.styleReference === target.testPath) lines.push('- Style reference: the existing test file; extend it in the same style.');
  else if (ctx.styleReference) lines.push(`- Style reference: \`${ctx.styleReference}\``);
  if (ctx.diff) lines.push('', '## Change in this pull request', '', '```diff', ctx.diff, '```');
  if (target.knownProblems?.length) {
    lines.push('', '## What fails on the head commit', '');
    for (const group of groupFailures(target.knownProblems)) lines.push(`- ${group.label}: ${group.message}`);
  }
  lines.push('', '## Skills to load first', '', 'Load each with the Skill tool (external drivers: read the file).', '');
  for (const s of packet.skills) lines.push(`- ${s.name}: \`${s.path}\``);
  lines.push('', '## Rules', '');
  lines.push(`1. Write only \`${target.testPath}\`. Do not edit production code, fixtures, configuration, or other tests.`);
  lines.push('2. Assert intended behavior, derived from names, types, and the intent of the change. Do not derive expected values by tracing the implementation.');
  lines.push('3. Never delete or skip existing tests. Do not use `.only`, `.skip`, `.todo`, `@ts-ignore`, or `as any`.');
  lines.push('4. The test file is type-checked with the package (`tsc --noEmit`). It must compile.');
  lines.push('5. If a test fails because the source is wrong, keep the assertion and report it under `suspectedDefects`. Do not weaken it.');
  if (target.action === 'repair-existing') {
    lines.push('6. Change only assertions that this pull request explains, and list each one under `modifiedExistingAssertions`.');
  }
  lines.push('', '## Tools', '');
  lines.push(`- \`get_change_context\` (external drivers: \`uta tool change-context --target ${target.id}\`)`);
  lines.push(`- \`run_tests\` runs the test file in the sandbox (external drivers: \`uta tool run-tests --target ${target.id}\`). Runs left: ${toolRunsLeft}.`);
  lines.push(`- \`coverage_for_file\` shows covered lines after your last run (external drivers: \`uta tool coverage --target ${target.id}\`).`);
  lines.push('', 'The host re-runs every check after you finish. Your own runs are for iteration only.');
  if (feedback) {
    lines.push('', `## Feedback from attempt ${target.attempts - 1}`, '');
    lines.push(`Gate ${feedback.gate} failed (${feedback.class}): ${feedback.message}`);
    for (const group of groupFailures(feedback.failures ?? []).slice(0, 5)) lines.push('', `- ${group.label}`, '```', group.message, '```');
  }
  lines.push('', '## Finish', '');
  lines.push(`Reply with one JSON object (external drivers: save it and run \`uta submit --target ${target.id} --result <file>\`).`);
  lines.push('The values below only illustrate the shape. Use empty arrays where nothing applies.', '');
  lines.push('```json', JSON.stringify(RESULT_EXAMPLE, null, 2), '```');
  return { packet, prompt: `${lines.join('\n')}\n` };
}
