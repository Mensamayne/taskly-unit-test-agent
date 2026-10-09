import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { evaluateToolUse } from '../guard.mjs';
import { HarnessError } from '../lib/errors.mjs';
import { safeEnv } from '../lib/exec.mjs';
import { skillsFor } from '../packet.mjs';
import { saveRun, targetDir } from '../state.mjs';
import { toolChangeContext, toolCoverage, toolRunTests } from '../tools.mjs';

const AGENT = 'unit-test-author';
const REVIEWER = 'test-reviewer';
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['test', 'check', 'note'],
        properties: { test: { type: 'string' }, check: { type: 'string' }, note: { type: 'string' } },
      },
    },
  },
};
const DENIED_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit', 'TodoWrite'];

const finding = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const str = { type: 'string' };

/** JSON Schema for the author self-report; the API enforces it through structured output. */
export const RESULT_SCHEMA = finding({
  cases: { type: 'array', items: str },
  notCovered: { type: 'array', items: finding({ what: str, why: str }) },
  suspectedDefects: { type: 'array', items: finding({ test: str, reason: str }) },
  modifiedExistingAssertions: { type: 'array', items: finding({ test: str, reason: str }) },
});

/**
 * Read a custom agent from `.claude/agents/<name>.md` in the trusted checkout.
 * The SDK's own `agent` option replaces the session's tool list with the agent's and drops the
 * Skill and StructuredOutput tools (Agent SDK 0.3.282), so the definition is applied here:
 * its body becomes the system prompt and its `tools` the tool list.
 * @param {string} configRoot
 * @param {string} name
 */
export function loadAgentDefinition(configRoot, name) {
  const file = join(configRoot, '.claude', 'agents', `${name}.md`);
  if (!existsSync(file)) throw new HarnessError('agent_missing', `Agent definition not found: ${file}`);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) throw new HarnessError('agent_invalid', `Agent definition has no frontmatter: ${file}`);
  const front = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (m) front[m[1]] = m[2].trim();
  }
  const tools = (front.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return {
    name: front.name ?? name,
    prompt: lines.slice(end + 1).join('\n').trim(),
    builtInTools: tools.filter((t) => !t.startsWith('mcp__')),
    mcpTools: tools.filter((t) => t.startsWith('mcp__')),
  };
}

/**
 * A home directory owned by the run. The agent process does not see the user's ~/.claude
 * (settings, plugins, memory, credentials); sessions persist there so repairs can resume.
 */
function agentHome(state) {
  if (!state.agentHome || !existsSync(state.agentHome)) state.agentHome = mkdtempSync(join(tmpdir(), 'uta-agent-home-'));
  return state.agentHome;
}

/** Environment of the agent process: OS plumbing, an isolated home, the model credential. No GitHub token. */
function agentEnv(home) {
  return {
    ...safeEnv({}, process.env),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    ...modelEnv(),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'taskly-unit-test-agent/0.2',
  };
}

/** Model credential and endpoint for the agent process (an API gateway or proxy may set the base URL). */
function modelEnv() {
  const env = {};
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** True for the SDK errors raised when a session reaches maxBudgetUsd or maxTurns. */
export function isLimitError(err) {
  return /maximum budget|max(?:imum)?[_ ]?(?:number of )?turns|error_max_(?:budget|turns)/i.test(String(err?.message ?? err));
}

function asText(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** The three author tools as an in-process MCP server bound to one target. */
function taskTools({ root, state, target, config }) {
  const guarded = (fn) => async () => {
    try {
      return asText(await fn());
    } catch (err) {
      return asText({ error: err.code ?? 'error', message: err.message }, true);
    }
  };
  return createSdkMcpServer({
    name: 'taskly',
    version: '1.0.0',
    tools: [
      tool('get_change_context', 'Change context for the current target: source, test file, changed lines, lines to cover, existing test titles, style reference.', {}, guarded(() => toolChangeContext({ root, state, targetId: target.id }))),
      tool('run_tests', 'Run the target test file in the sandbox. Returns status, failures, and runs left. Budgeted.', {}, guarded(() => toolRunTests({ root, state, targetId: target.id, config }))),
      tool('coverage_for_file', 'Target lines covered and still uncovered after the last run_tests call.', {}, guarded(() => toolCoverage({ root, state, targetId: target.id }))),
    ],
  });
}

function summarizeMessage(msg) {
  if (msg.type === 'assistant') {
    return (msg.message?.content ?? []).map((block) => {
      if (block.type === 'text') return { text: block.text.slice(0, 2000) };
      if (block.type === 'tool_use') return { tool: block.name, input: JSON.stringify(block.input).slice(0, 500) };
      return { block: block.type };
    });
  }
  if (msg.type === 'result') return { result: msg.subtype, turns: msg.num_turns, costUsd: msg.total_cost_usd };
  if (msg.type === 'system' && msg.subtype === 'init') return { init: { model: msg.model, tools: msg.tools, skills: msg.skills, agents: msg.agents } };
  return null;
}

/**
 * Agent SDK driver. One SDK session per target; repairs resume the same session.
 * `configRoot` is the trusted checkout whose `.claude/` (agent, skills) is loaded;
 * `root` is the workspace under test.
 * @param {{ configRoot: string }} opts
 */
export function createSdkDriver({ configRoot }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HarnessError('missing_api_key', 'ANTHROPIC_API_KEY is not set. Without a key, drive the run with --author external.');
  }
  const author = loadAgentDefinition(configRoot, AGENT);
  const reviewer = loadAgentDefinition(configRoot, REVIEWER);
  return {
    kind: 'sdk',

    /** Reason the run cannot afford another session, or null. */
    budgetBlock(state, target, config) {
      if ((state.costUsd ?? 0) >= config.budgets.usdPerRun) return `run budget of $${config.budgets.usdPerRun} used`;
      if ((target.costUsd ?? 0) >= config.budgets.usdPerTarget) return `target budget of $${config.budgets.usdPerTarget} used`;
      return null;
    },

    async author({ root, state, target, prompt, config }) {
      const remaining = Math.min(config.budgets.usdPerTarget - (target.costUsd ?? 0), config.budgets.usdPerRun - (state.costUsd ?? 0));
      const transcript = join(targetDir(root, state.runId, target.id), `attempt-${target.attempts}`, 'transcript.jsonl');
      mkdirSync(dirname(transcript), { recursive: true });
      const allowedWrites = [target.testPath];
      const guardHook = async (input) => {
        const verdict = evaluateToolUse(root, input, { allowedWrites });
        return verdict.decision === 'deny'
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }
          : {};
      };

      const builtIns = [...author.builtInTools, 'Skill'];
      const options = {
        cwd: root,
        projectConfigRoot: configRoot,
        settingSources: ['project'],
        systemPrompt: author.prompt,
        model: config.model,
        skills: skillsFor(target, Boolean(target.feedback)),
        tools: builtIns,
        allowedTools: [...builtIns, ...author.mcpTools, 'StructuredOutput'],
        disallowedTools: DENIED_TOOLS,
        permissionMode: 'dontAsk',
        mcpServers: { taskly: taskTools({ root, state, target, config }) },
        hooks: { PreToolUse: [{ hooks: [guardHook] }] },
        maxTurns: config.budgets.maxTurns,
        maxBudgetUsd: Math.max(0.05, remaining),
        outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
        env: agentEnv(agentHome(state)),
        ...(target.sessionId ? { resume: target.sessionId } : {}),
      };

      let result = null;
      let limit = null;
      try {
        for await (const msg of query({ prompt, options })) {
          if (msg.session_id && !target.sessionId) target.sessionId = msg.session_id;
          const line = summarizeMessage(msg);
          if (line) appendFileSync(transcript, `${JSON.stringify({ type: msg.type, ...(Array.isArray(line) ? { blocks: line } : line) })}\n`);
          if (msg.type === 'result') result = msg;
        }
      } catch (err) {
        // The SDK throws when a session hits its budget or turn limit. That ends this session,
        // not the run: the gates judge what was written and the budgets decide what comes next.
        if (!isLimitError(err)) throw err;
        limit = err.message;
      }

      // Without a reported cost, assume the session spent its whole allowance.
      const cost = result?.total_cost_usd ?? (limit ? options.maxBudgetUsd : 0);
      target.costUsd = (target.costUsd ?? 0) + cost;
      state.costUsd = (state.costUsd ?? 0) + cost;
      target.sessions = [...(target.sessions ?? []), {
        attempt: target.attempts, subtype: result?.subtype ?? (limit ? 'limit' : 'no-result'), turns: result?.num_turns ?? 0, costUsd: cost,
        ...(limit ? { limit } : {}),
      }];
      if (limit) appendFileSync(transcript, `${JSON.stringify({ type: 'limit', message: limit })}\n`);
      saveRun(root, state);

      if (result?.subtype === 'success' && result.structured_output) return result.structured_output;
      // Budget or turn limits end the session without a report; the gates still judge what was written.
      return {};
    },

    /** Advisory review of an accepted test file. Read-only tools; findings never block. */
    async review({ root, state, target, config }) {
      if ((state.costUsd ?? 0) >= config.budgets.usdPerRun) return null;
      const options = {
        cwd: root,
        projectConfigRoot: configRoot,
        settingSources: ['project'],
        systemPrompt: reviewer.prompt,
        model: config.reviewerModel,
        skills: ['test-quality-review'],
        tools: [...reviewer.builtInTools, 'Skill'],
        allowedTools: [...reviewer.builtInTools, 'Skill', 'StructuredOutput'],
        disallowedTools: [...DENIED_TOOLS, 'Write', 'Edit'],
        permissionMode: 'dontAsk',
        maxTurns: 12,
        maxBudgetUsd: Math.max(0.05, Math.min(0.3, config.budgets.usdPerRun - (state.costUsd ?? 0))),
        outputFormat: { type: 'json_schema', schema: REVIEW_SCHEMA },
        env: agentEnv(agentHome(state)),
      };
      const prompt = `Review the unit tests in \`${target.testPath}\` for \`${target.path}\`. Return the findings object.`;
      let result = null;
      let limited = false;
      try {
        for await (const msg of query({ prompt, options })) if (msg.type === 'result') result = msg;
      } catch (err) {
        // The review is advisory: a limit or an error drops the notes, never the accepted test.
        limited = isLimitError(err);
        if (!limited) return null;
      }
      const cost = result?.total_cost_usd ?? (limited ? options.maxBudgetUsd : 0);
      state.costUsd = (state.costUsd ?? 0) + cost;
      saveRun(root, state);
      return result?.subtype === 'success' ? (result.structured_output?.findings ?? []) : null;
    },
  };
}
