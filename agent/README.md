# Unit-test agent harness

Deterministic pipeline that decides which changed files need unit tests, hands each one to an author, and accepts the result only after it passes the acceptance gates. Taskly code in `frontend/` and `backend/` never imports anything from here.

```
preflight -> collect diff -> baseline (suites, coverage, tsc) -> plan
  -> per target: author -> gates G1..G7 -> repair (max 2) -> accepted | rejected
  -> final suites -> report.md, tests.patch, run.json
```

## Authors (drivers)

| Driver | Use |
|--------|-----|
| `sdk` | Claude Agent SDK session per target with the custom agent `.claude/agents/unit-test-author.md` and the skills in `.claude/skills/`. Repairs resume the same session. Default in CI. Needs `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL` is forwarded for gateways). The agent process gets an isolated home directory. |
| `external` | The run stops at every target and hands the task packet to whoever runs the CLI (a person, Cursor, Claude Code). Refused when `CI=true`. |
| `stub` | Replays recorded author output from a JSON script. Used by the harness tests. |

After a target is accepted, the `sdk` driver asks the read-only `test-reviewer` agent for advisory findings (shown in the report, never blocking). The reviewer is given only the tests added in the run (plus existing ones the author reports changing), and findings about other tests are dropped.

Every driver gets the same task packet (`prompt.md`), the same tools, the same budgets, and the same gates. The host owns the state; nothing an author claims is trusted.

## CLI

Run from the repository root with dependencies installed in `backend/` and `frontend/`.

```sh
node agent/src/cli.mjs run --mode pr --base origin/main --author external
node agent/src/cli.mjs packet --target t1          # the prompt the author gets
node agent/src/cli.mjs tool run-tests --target t1   # optional inner loop, budgeted
node agent/src/cli.mjs tool coverage --target t1
node agent/src/cli.mjs submit --target t1 --result result.json
node agent/src/cli.mjs gate --target t1             # authoritative; on failure prints the repair packet
node agent/src/cli.mjs resume                       # next target, or final report
node agent/src/cli.mjs status
node agent/src/cli.mjs abort
```

`--mode bootstrap [--sides backend,frontend]` targets files below the line coverage threshold instead of a diff.

`--config-root <dir>` points the `sdk` driver at the checkout whose `.claude/` (agent, skills, hooks) is trusted. In CI that is the base branch, so a pull request cannot change the agent that reviews it.

Output is JSON on stdout. Exit codes: 0 ok, 1 error, 2 usage, 3 awaiting author, 4 run failed (scope violation or author error).

Run state lives in `.uta-runs/<run id>/` (gitignored): `state.json`, per-target packets, gate logs, and the final `report.md`, `tests.patch`, `run.json`.

## Gates

| Gate | Check |
|------|-------|
| G0 progress | A file identical to one that already failed is rejected without running anything |
| G1 scope | Only the target's test file changed anywhere in the worktree since the target was handed out. Any other change fails the whole run. |
| G2 static | No `.only/.skip/.todo`, `@ts-ignore`, `as any`, unstubbed `Math.random`/`randomUUID`; every test asserts; no existing test removed; imports resolve without new dependencies |
| G3 typecheck | `tsc --noEmit` adds no new errors |
| G4 pass | The test file passes |
| G6 value | It covers at least one of the target lines (not applied to `repair-existing`) |
| G5 stable | Passes repeatedly in shuffled order |
| G7 suite | The full package suite has no new failures |

After every test run (G4, G5, G7, the author's own `run_tests`, and the final verification) the worktree is checked again: a test that writes outside its own file is reverted and fails with class `side-effect`.

A failing assertion that the author explains as a defect in the source is not repaired: if the claim names a test that failed on an assertion, the test is dropped and reported as a suspected defect (marked as unverified). A repair that fails exactly like the previous attempt stops the target early. An environment failure (no Vitest report, `tsc` not running) is class `infra`: retried once, never charged to the author, and reported as "not verified" if it persists.

## Safety

- Child processes that run repository code get an allowlisted environment (no API keys or tokens).
- `TEST_SANDBOX=docker` runs Vitest and tsc in a container with no network and resource limits (CI).
- The write allowlist (`backend/tests/**/*.test.ts`, `frontend/src/**/*.test.ts(x)`) is enforced by the write hook (`uta hook`), by G1, and again before publishing.

## In GitHub Actions

`.github/workflows/unit-test-agent.yml` runs on pull requests that touch `frontend/src` or `backend/src`, and on manual dispatch (bootstrap mode). The `author` job has the model key and a read-only token; the `publish` job has a write token, never runs repository code, validates the patch with `src/publish.mjs`, commits accepted tests to the PR branch (`TEST_AGENT_MODE=commit`, the default) or only reports (`comment`), and keeps one updated comment on the PR. With the `UNIT_TEST_AGENT_PUSH_TOKEN` secret the commit is pushed with that token, so CI runs on it; the next agent run sees its own commit (message `Accepted by the unit-test agent (run ...)`) as the PR head and stops without touching the comment.

Without the `ANTHROPIC_API_KEY` secret the author job skips generation and the publish job still updates the sticky PR comment explaining the skip. A local run (any driver) can be published to a pull request with the same validation:

```sh
node agent/src/publish.mjs --identity local --run .uta-runs/<run id> --repo <owner>/<repo> --pr <number> --workspace .
```

`--identity local` commits with your git identity and keeps the sticky comment under your account.

## Budgets

Read from the environment and clamped to hard maximums in `src/config.mjs`: `UTA_MAX_TARGETS` (8, max 20), `UTA_MAX_REPAIRS` (2), `UTA_MAX_TOOL_RUNS` (4, max 6), `UTA_MAX_TURNS` (30, max 50), `UTA_USD_PER_TARGET` (1, max 2), `UTA_USD_PER_RUN` (6, max 10), `UTA_COMMAND_TIMEOUT_MS`, `UTA_STABILITY_RUNS`, `UTA_BOOTSTRAP_THRESHOLD`. Model: `TEST_AGENT_MODEL` (default `claude-sonnet-5-5`), reviewer `TEST_AGENT_REVIEWER_MODEL` (default `claude-haiku-5-5`).

## Tests

```sh
cd agent && npm test
```

Unit tests for planning, guards, static checks, packets, and reporting, plus end-to-end runs of the CLI against a disposable git worktree with real Vitest and tsc:

- `e2e.test.mjs`: stub and external drivers, repairs, scope violations, side effects, author failures
- `sdk.e2e.test.mjs`: the real Agent SDK and Claude Code process against a scripted Messages API (`test/support/fake-anthropic.mjs`)
- `docker.e2e.test.mjs`: the Docker sandbox, including a hanging test and its container (Linux with Docker; skipped elsewhere)

## Removing the harness

Delete `agent/`, `.claude/`, and the agent workflow. Taskly and its normal CI keep working; tests the agent wrote are ordinary Vitest files.
