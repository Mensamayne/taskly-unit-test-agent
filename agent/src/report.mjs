import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchFor } from './lib/git.mjs';
import { runDir } from './state.mjs';

export const COMMENT_MARKER = '<!-- taskly-unit-test-agent -->';
const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function coverageCell(t) {
  if (t.action === 'repair-existing') return 'n/a';
  const total = t.linesToCover.length;
  const gained = t.coverage?.gained ?? 0;
  return t.status === 'accepted' ? `${gained}/${total} target lines` : `0/${total} target lines`;
}

/** Overall verification line, literal by contract. */
export function verificationLine(state) {
  const sides = Object.keys(state.final ?? {});
  if (state.stage === 'failed') return `Could not verify the result: the run failed (${state.failure?.code ?? 'unknown'})`;
  if (!sides.length) return 'Tests were not run: no source changes in frontend/ or backend/';
  const ok = sides.every((s) => state.final[s].status === 'pass' && state.final[s].newTypeErrors === 0);
  return ok ? 'Tests passed' : 'Tests failed';
}

/** Run summary without bulky internals, safe to publish as an artifact. */
export function publicRun(state) {
  return {
    ...state,
    targets: state.targets.map(({ snapshot, originalTestContent, ...rest }) => rest),
  };
}

/** Markdown body for the PR comment and the job summary. */
export function renderReport(state) {
  const accepted = state.targets.filter((t) => t.status === 'accepted');
  const lines = [COMMENT_MARKER, '### Unit test agent', ''];
  const head = state.head?.slice(0, 7) ?? '?';
  lines.push(`Mode: ${state.mode}. Head: ${head}. Driver: ${state.driver}. Accepted: ${accepted.length} of ${state.targets.length} target(s). ${verificationLine(state)}.`, '');

  if (state.stage === 'failed') {
    lines.push(`Run failed: ${state.failure?.code}: ${escapeCell(state.failure?.message)}`, '');
  }
  if (state.stage === 'skipped') {
    lines.push(`Run skipped: ${state.skipReason}.`, '');
    return `${lines.join('\n')}\n`;
  }

  if (state.targets.length) {
    lines.push('| File | Decision | Test file | Outcome | Coverage |', '|------|----------|-----------|---------|----------|');
    for (const t of state.targets) {
      lines.push(`| \`${t.path}\` | ${t.action} | \`${t.testPath}\` | ${escapeCell(t.outcome ?? t.status)} | ${coverageCell(t)} |`);
    }
    lines.push('');
  } else {
    lines.push('No file needed new or updated unit tests.', '');
  }

  if (state.noops.length) {
    lines.push('<details><summary>Files without action</summary>', '');
    for (const n of state.noops) lines.push(`- \`${n.path}\`: ${escapeCell(n.reason)}${n.note ? ` (${escapeCell(n.note)})` : ''}`);
    lines.push('', '</details>', '');
  }

  lines.push('**Verification**', '');
  for (const [side, f] of Object.entries(state.final ?? {})) {
    lines.push(`- ${side}: full suite ${f.status} (${f.tests} tests), new type errors: ${f.newTypeErrors}`);
    if (f.sideEffects?.length) lines.push(`  - tests changed files outside the test files (reverted): ${f.sideEffects.join(', ')}`);
  }
  lines.push('- Per target: tsc --noEmit, vitest run on the test file (repeated, shuffled), scoped coverage, full package suite');
  lines.push(`- Result: ${verificationLine(state)}`, '');

  const defects = state.targets.filter((t) => t.outcome === 'suspected defect');
  lines.push('**Suspected defects**', '');
  if (!defects.length) lines.push('- none');
  else lines.push('Claimed by the author for assertions that failed against the current source. Not verified by the harness; check before acting.', '');
  for (const t of defects) {
    for (const d of t.defectClaims ?? t.result?.suspectedDefects ?? []) lines.push(`- \`${t.path}\`: ${escapeCell(d.test)}. ${escapeCell(d.reason)}`);
    for (const f of t.defectFailures ?? []) {
      const detail = f.message.split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).join(' ');
      lines.push(`  - failing assertion: ${escapeCell(detail)}`);
    }
  }
  lines.push('');

  const review = accepted.filter((t) => t.reviewNotes?.length || t.result?.modifiedExistingAssertions?.length);
  lines.push('**Review required**', '');
  if (!review.length) lines.push('- none (no pre-existing assertions modified)');
  for (const t of review) {
    for (const m of t.result?.modifiedExistingAssertions ?? []) lines.push(`- \`${t.testPath}\`: ${escapeCell(m.test)}. ${escapeCell(m.reason)}`);
    for (const r of t.reviewNotes ?? []) lines.push(`- \`${t.testPath}\`: removed assertion \`${escapeCell(r)}\``);
  }
  lines.push('');

  const reviewed = accepted.filter((t) => t.reviewFindings?.length);
  if (reviewed.length) {
    lines.push('**Reviewer notes** (advisory)', '');
    for (const t of reviewed) for (const f of t.reviewFindings) lines.push(`- \`${t.testPath}\` ${escapeCell(f.test)}: ${escapeCell(f.check)}. ${escapeCell(f.note)}`);
    lines.push('');
  }

  lines.push('<details><summary>Run details</summary>', '');
  if (state.costUsd) lines.push(`- Model cost (estimate): $${state.costUsd.toFixed(2)}`);
  for (const [side, b] of Object.entries(state.baseline)) {
    lines.push(`- Baseline ${side}: ${b.tests} tests, ${b.linePercent}% lines, ${b.failingTests.length} failing`);
  }
  for (const t of state.targets) {
    const notCovered = (t.result?.notCovered ?? []).map((n) => `${n.what} (${n.why})`).join('; ');
    lines.push(`- ${t.id} \`${t.path}\`: attempts ${t.attempts}, repairs ${t.repairs}${notCovered ? `, not covered: ${escapeCell(notCovered)}` : ''}`);
    for (const h of t.history) if (h.gate) lines.push(`  - attempt ${h.attempt}: ${h.gate} ${h.class}: ${escapeCell(h.message).slice(0, 300)}`);
  }
  lines.push('', '</details>');
  return `${lines.join('\n')}\n`;
}

/** Write report.md, run.json, and tests.patch into the run directory. */
export async function writeReport(root, state) {
  const dir = runDir(root, state.runId);
  const body = renderReport(state);
  if (SECRET_RE.test(body)) throw new Error('report contains something that looks like a secret; refusing to write it');
  const accepted = state.targets.filter((t) => t.status === 'accepted').map((t) => t.testPath);
  const patch = accepted.length ? await patchFor(root, accepted) : '';
  writeFileSync(join(dir, 'report.md'), body);
  writeFileSync(join(dir, 'tests.patch'), patch);
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(publicRun(state), null, 2)}\n`);
  state.artifacts = { report: join(dir, 'report.md'), patch: join(dir, 'tests.patch'), run: join(dir, 'run.json') };
  return state.artifacts;
}
