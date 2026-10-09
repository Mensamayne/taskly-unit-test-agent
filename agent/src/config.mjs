/**
 * Runtime configuration. Every budget is read from the environment and clamped to a hard maximum,
 * so a misconfigured variable can lower limits but never lift them past the cap.
 */

const BUDGETS = {
  maxTargets: { env: 'UTA_MAX_TARGETS', def: 8, min: 1, max: 20 },
  maxRepairs: { env: 'UTA_MAX_REPAIRS', def: 2, min: 0, max: 2 },
  maxToolRuns: { env: 'UTA_MAX_TOOL_RUNS', def: 4, min: 0, max: 6 },
  maxTurns: { env: 'UTA_MAX_TURNS', def: 30, min: 5, max: 50 },
  usdPerTarget: { env: 'UTA_USD_PER_TARGET', def: 1, min: 0.1, max: 2 },
  usdPerRun: { env: 'UTA_USD_PER_RUN', def: 6, min: 0.5, max: 10 },
  commandTimeoutMs: { env: 'UTA_COMMAND_TIMEOUT_MS', def: 120_000, min: 10_000, max: 300_000 },
  stabilityRuns: { env: 'UTA_STABILITY_RUNS', def: 3, min: 1, max: 5 },
  bootstrapLineThreshold: { env: 'UTA_BOOTSTRAP_THRESHOLD', def: 80, min: 1, max: 100 },
};

const SANDBOXES = ['local', 'docker'];
// The Docker official image through the ECR Public mirror: anonymous Docker Hub pulls from shared
// CI runners hit the rate limit. The digest pins the content, so the mirror cannot change it.
const DEFAULT_IMAGE = 'public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';
const DEFAULT_BOOTSTRAP_SKIP = ['backend/src/main.ts'];

function clampNumber(raw, spec) {
  const value = raw === undefined || raw === '' ? spec.def : Number(raw);
  if (!Number.isFinite(value)) return spec.def;
  return Math.min(Math.max(value, spec.min), spec.max);
}

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
  /** @type {Record<keyof typeof BUDGETS, number>} */
  const budgets = /** @type {any} */ ({});
  for (const [name, spec] of Object.entries(BUDGETS)) budgets[name] = clampNumber(env[spec.env], spec);
  const sandbox = SANDBOXES.includes(env.TEST_SANDBOX ?? '') ? env.TEST_SANDBOX : 'local';
  return {
    budgets,
    sandbox,
    sandboxImage: env.UTA_SANDBOX_IMAGE || DEFAULT_IMAGE,
    model: env.TEST_AGENT_MODEL || 'claude-sonnet-5-5',
    reviewerModel: env.TEST_AGENT_REVIEWER_MODEL || 'claude-haiku-5-5',
    bootstrapSkip: env.UTA_BOOTSTRAP_SKIP ? env.UTA_BOOTSTRAP_SKIP.split(',').map((s) => s.trim()) : DEFAULT_BOOTSTRAP_SKIP,
    inCi: env.CI === 'true' || env.GITHUB_ACTIONS === 'true',
    botEmails: ['41898282+github-actions[bot]@users.noreply.github.com'],
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
