import { appendFileSync, mkdirSync } from 'node:fs';
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
const BUILT_IN_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit'];
const MCP_TOOLS = ['mcp__taskly__get_change_context', 'mcp__taskly__run_tests', 'mcp__taskly__coverage_for_file'];
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
  if (!process.env.ANTHROPIC_API_KEY && !process.env.UTA_ALLOW_LOCAL_LOGIN) {
    throw new HarnessError('missing_api_key', 'ANTHROPIC_API_KEY is not set (locally, UTA_ALLOW_LOCAL_LOGIN=1 uses the Claude Code login instead).');
  }
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

      const options = {
        cwd: root,
        projectConfigRoot: configRoot,
        settingSources: ['project'],
        agent: AGENT,
        model: config.model,
        skills: skillsFor(target, Boolean(target.feedback)),
        tools: BUILT_IN_TOOLS,
        allowedTools: [...BUILT_IN_TOOLS, ...MCP_TOOLS],
        disallowedTools: DENIED_TOOLS,
        permissionMode: 'dontAsk',
        mcpServers: { taskly: taskTools({ root, state, target, config }) },
        hooks: { PreToolUse: [{ hooks: [guardHook] }] },
        maxTurns: config.budgets.maxTurns,
        maxBudgetUsd: Math.max(0.05, remaining),
        outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
        // The agent process gets OS plumbing and the model credential only. No GitHub token.
        env: {
          ...safeEnv({}, process.env),
          ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'taskly-unit-test-agent/0.2',
        },
        ...(target.sessionId ? { resume: target.sessionId } : {}),
      };

      let result = null;
      for await (const msg of query({ prompt, options })) {
        if (msg.session_id && !target.sessionId) target.sessionId = msg.session_id;
        const line = summarizeMessage(msg);
        if (line) appendFileSync(transcript, `${JSON.stringify({ type: msg.type, ...(Array.isArray(line) ? { blocks: line } : line) })}\n`);
        if (msg.type === 'result') result = msg;
      }

      const cost = result?.total_cost_usd ?? 0;
      target.costUsd = (target.costUsd ?? 0) + cost;
      state.costUsd = (state.costUsd ?? 0) + cost;
      target.sessions = [...(target.sessions ?? []), { attempt: target.attempts, subtype: result?.subtype ?? 'no-result', turns: result?.num_turns ?? 0, costUsd: cost }];
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
        agent: REVIEWER,
        model: config.reviewerModel,
        skills: ['test-quality-review'],
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [...DENIED_TOOLS, 'Write', 'Edit'],
        permissionMode: 'dontAsk',
        maxTurns: 12,
        maxBudgetUsd: Math.max(0.05, Math.min(0.3, config.budgets.usdPerRun - (state.costUsd ?? 0))),
        outputFormat: { type: 'json_schema', schema: REVIEW_SCHEMA },
        env: {
          ...safeEnv({}, process.env),
          ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        },
      };
      const prompt = `Review the unit tests in \`${target.testPath}\` for \`${target.path}\`. Return the findings object.`;
      let result = null;
      for await (const msg of query({ prompt, options })) if (msg.type === 'result') result = msg;
      const cost = result?.total_cost_usd ?? 0;
      state.costUsd = (state.costUsd ?? 0) + cost;
      saveRun(root, state);
      return result?.subtype === 'success' ? (result.structured_output?.findings ?? []) : null;
    },
  };
}
