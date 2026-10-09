import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assistantTurns, requestText, startFakeAnthropic, toolResults } from './support/fake-anthropic.mjs';

/**
 * The sdk driver end to end: real Agent SDK, real Claude Code process, real MCP tools, hooks,
 * skills, Vitest, and tsc. Only the model is replaced by a scripted fake Messages API.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'agent', 'src', 'cli.mjs');
const SDK = join(REPO, 'agent', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const TMP = mkdtempSync(join(tmpdir(), 'uta-sdk-'));
const WT = join(TMP, 'wt');
const SOURCE = 'backend/src/features/todos/uta-e2e-sample.ts';

const SAMPLE = `import type { Todo } from './types.js';

export function countCompleted(todos: Pick<Todo, 'completed'>[]): number {
  return todos.filter((todo) => todo.completed).length;
}
`;

const GOOD_TEST = `import { describe, expect, it } from 'vitest';
import { countCompleted } from '../src/features/todos/uta-e2e-sample.ts';

describe('countCompleted', () => {
  it('counts only completed tasks', () => {
    expect(countCompleted([{ completed: true }, { completed: false }, { completed: true }])).toBe(2);
  });
  it('returns zero for an empty list', () => {
    expect(countCompleted([])).toBe(0);
  });
});
`;

const WRONG_TEST = GOOD_TEST.replace('.toBe(2);', '.toBe(3);');

let scenario = 'happy';

const RESULT = {
  cases: ['counts only completed tasks', 'returns zero for an empty list'],
  notCovered: [],
  suspectedDefects: [],
  modifiedExistingAssertions: [],
};

/** The scripted model: one author session and one reviewer session. */
function model(body) {
  const names = (body.tools ?? []).map((t) => t.name);
  const text = requestText(body);
  if (names.includes('Write')) {
    const cwd = /Primary working directory: ([^\\"]+?)(?:\\n|")/.exec(text)?.[1] ?? WT;
    const testPath = /Test file: `([^`]+)`/.exec(text)?.[1];
    if (scenario === 'repair') {
      // Turns since the latest prompt: a repair prompt carries the gate feedback.
      const msgs = body.messages ?? [];
      const lastPrompt = msgs.map((m) => JSON.stringify(m.content)).findLastIndex((c) => c.includes('# Unit test task'));
      const turn = msgs.slice(lastPrompt + 1).filter((m) => m.role === 'assistant').length;
      const repairing = JSON.stringify(msgs[lastPrompt]?.content ?? '').includes('Feedback from attempt');
      const steps = [
        { type: 'tool_use', name: 'Write', input: { file_path: join(cwd, testPath), content: repairing ? GOOD_TEST : WRONG_TEST } },
        { type: 'tool_use', name: 'StructuredOutput', input: RESULT },
      ];
      return [steps[turn] ?? { type: 'text', text: 'Done.' }];
    }
    const steps = [
      { type: 'tool_use', name: 'Skill', input: { skill: 'backend-unit-tests' } },
      { type: 'tool_use', name: 'Read', input: { file_path: join(REPO, '.claude', 'skills', 'backend-unit-tests', 'references', 'patterns.md') } },
      { type: 'tool_use', name: 'Read', input: { file_path: join(cwd, '.env') } },
      { type: 'tool_use', name: 'mcp__taskly__get_change_context', input: {} },
      { type: 'tool_use', name: 'Write', input: { file_path: join(cwd, SOURCE), content: '// rewritten by the model\n' } },
      { type: 'tool_use', name: 'Write', input: { file_path: join(cwd, testPath), content: GOOD_TEST } },
      { type: 'tool_use', name: 'mcp__taskly__run_tests', input: {} },
      { type: 'tool_use', name: 'StructuredOutput', input: RESULT },
    ];
    const step = steps[assistantTurns(body)];
    return [step ?? { type: 'text', text: 'Done.' }];
  }
  if (names.includes('StructuredOutput')) {
    return assistantTurns(body) === 0
      ? [{ type: 'tool_use', name: 'StructuredOutput', input: { findings: [{ test: 'counts only completed tasks', check: 'readability', note: 'fake reviewer note' }] } }]
      : [{ type: 'text', text: 'Done.' }];
  }
  return [{ type: 'text', text: '{"title":"Unit test task"}' }];
}

function git(args, cwd = WT) {
  const out = spawnSync('git', ['-c', 'user.name=uta-test', '-c', 'user.email=uta-test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function runCli(args, env) {
  return new Promise((resolvePromise) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.CI;
    delete childEnv.GITHUB_ACTIONS;
    const child = spawn(process.execPath, [CLI, ...args, '--root', WT], { cwd: WT, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
  });
}

let api;

before(async () => {
  api = await startFakeAnthropic(model);
  git(['worktree', 'add', '--detach', WT, 'HEAD'], REPO);
  for (const side of ['backend', 'frontend']) symlinkSync(join(REPO, side, 'node_modules'), join(WT, side, 'node_modules'), 'junction');
  cpSync(join(REPO, 'backend', 'src', 'generated'), join(WT, 'backend', 'src', 'generated'), { recursive: true });
  writeFileSync(join(WT, SOURCE), SAMPLE);
  git(['add', SOURCE]);
  git(['commit', '-qm', 'feat: count completed tasks (harness test fixture)']);
});

after(async () => {
  for (const side of ['backend', 'frontend']) {
    const link = join(WT, side, 'node_modules');
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
  spawnSync('git', ['worktree', 'remove', '--force', WT], { cwd: REPO });
  rmSync(TMP, { recursive: true, force: true });
  await api?.close();
});

describe('sdk driver with a scripted model', { skip: !existsSync(SDK) && 'agent dependencies not installed', timeout: 600_000 }, () => {
  it('runs the custom agent with its skills, tools, and guards, and the reviewer after acceptance', async () => {
    const run = await runCli(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'sdk', '--config-root', REPO], {
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      ANTHROPIC_BASE_URL: api.url,
    });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(run.json.targets.map((t) => [t.path, t.status, t.attempts]), [[SOURCE, 'accepted', 1]]);

    const author = api.requests.filter((b) => (b.tools ?? []).some((t) => t.name === 'Write'));
    assert.ok(author.length >= 8, `expected a full author session, got ${author.length} requests`);
    const first = author[0];
    const tools = first.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['Edit', 'Glob', 'Grep', 'Read', 'Skill', 'StructuredOutput', 'Write', 'mcp__taskly__coverage_for_file', 'mcp__taskly__get_change_context', 'mcp__taskly__run_tests']);
    assert.match(requestText(first), /You receive a task packet/, 'system prompt comes from .claude/agents/unit-test-author.md');
    assert.match(requestText(first), /backend-unit-tests/, 'the packet names the skills to load');

    const results = toolResults(author[author.length - 1]);
    const by = (name) => results.filter((r) => r.name === name);
    assert.match(by('Skill')[0].text, /Backend unit tests|backend-unit-tests/i, 'the skill was loaded');
    const [reference, secret] = by('Read');
    assert.equal(reference.isError, false, 'skill reference files are readable from the trusted checkout');
    assert.match(reference.text, /Backend test patterns/);
    assert.equal(secret.isError, true);
    assert.match(secret.text, /not allowed: \.env/);
    assert.match(by('mcp__taskly__get_change_context')[0].text, /"target": "t1"/);
    const [denied, written] = by('Write');
    assert.equal(denied.isError, true);
    assert.match(denied.text, /not a writable test path/);
    assert.equal(written.isError, false);
    assert.match(by('mcp__taskly__run_tests')[0].text, /"status": "pass"/);

    const all = api.requests.map(requestText).join('\n');
    assert.ok(!all.includes(join(homedir(), '.claude').replaceAll('\\', '\\\\')), 'nothing from the user home reaches the model');
    assert.ok(!all.includes('MEMORY.md'), 'no user memory reaches the model');

    assert.equal(git(['status', '--porcelain', '--', 'backend/src']).trim(), '', 'the production file was not rewritten');
    const report = readFileSync(run.json.artifacts.report, 'utf8');
    assert.match(report, /Driver: sdk\. Accepted: 1 of 1/);
    assert.match(report, /fake reviewer note/);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
    assert.equal(state.targets[0].sessions[0].subtype, 'success');
  });

  it('repairs by resuming the same SDK session with the gate feedback', async () => {
    git(['reset', '-q', '--hard', 'HEAD']);
    git(['clean', '-fdq', '-e', 'node_modules', '--', 'backend', 'frontend']);
    rmSync(join(WT, '.uta-runs'), { recursive: true, force: true });
    scenario = 'repair';
    const before = api.requests.length;
    const run = await runCli(['run', '--mode', 'pr', '--base', 'HEAD~1', '--author', 'sdk', '--config-root', REPO], {
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      ANTHROPIC_BASE_URL: api.url,
    });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(run.json.targets.map((t) => [t.status, t.attempts]), [['accepted', 2]]);
    const state = JSON.parse(readFileSync(join(WT, '.uta-runs', run.json.runId, 'state.json'), 'utf8'));
    const [target] = state.targets;
    assert.equal(target.history[0].gate, 'G4');
    assert.equal(target.history[0].class, 'assertion');
    assert.equal(target.sessions.length, 2);
    const repairRequests = api.requests.slice(before).filter((b) => requestText(b).includes('Feedback from attempt 1'));
    assert.ok(repairRequests.length > 0, 'the repair prompt reached the model');
    assert.match(requestText(repairRequests[0]), /toBe\(3\)/, 'the resumed session still holds the first attempt');
  });
});
