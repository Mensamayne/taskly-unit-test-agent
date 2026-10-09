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
| `sdk` | Claude Agent SDK with the custom agent in `.claude/agents/`. Default in CI. Not wired yet. |
| `external` | The run stops at every target and hands the task packet to whoever runs the CLI (a person, Cursor, Claude Code). Refused when `CI=true`. |
| `stub` | Replays recorded author output from a JSON script. Used by the harness tests. |

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

Output is JSON on stdout. Exit codes: 0 ok, 1 error, 2 usage, 3 awaiting author, 4 run failed (scope violation).

Run state lives in `.uta-runs/<run id>/` (gitignored): `state.json`, per-target packets, gate logs, and the final `report.md`, `tests.patch`, `run.json`.

## Gates

| Gate | Check |
|------|-------|
| G1 scope | Only the target's test file changed anywhere in the worktree since the target was handed out. Any other change fails the whole run. |
| G2 static | No `.only/.skip/.todo`, `@ts-ignore`, `as any`; every test asserts; no existing test removed; imports resolve without new dependencies |
| G3 typecheck | `tsc --noEmit` adds no new errors |
| G4 pass | The test file passes |
| G6 value | It covers at least one of the target lines (not applied to `repair-existing`) |
| G5 stable | Passes repeatedly in shuffled order |
| G7 suite | The full package suite has no new failures |

A failing assertion that the author explains as a defect in the source is not repaired: the test is dropped and reported as a suspected defect.

## Safety

- Child processes that run repository code get an allowlisted environment (no API keys or tokens).
- `TEST_SANDBOX=docker` runs Vitest and tsc in a container with no network and resource limits (CI).
- The write allowlist (`backend/tests/**/*.test.ts`, `frontend/src/**/*.test.ts(x)`) is enforced by the write hook (`uta hook`), by G1, and again before publishing.

## Budgets

Read from the environment and clamped to hard maximums in `src/config.mjs`: `UTA_MAX_TARGETS` (8, max 20), `UTA_MAX_REPAIRS` (2), `UTA_MAX_TOOL_RUNS` (4, max 6), `UTA_COMMAND_TIMEOUT_MS`, `UTA_STABILITY_RUNS`, `UTA_BOOTSTRAP_THRESHOLD`.

## Tests

```sh
cd agent && npm test
```

Unit tests for planning, guards, static checks, packets, and reporting, plus end-to-end runs of the CLI against a disposable git worktree with real Vitest and tsc.

## Removing the harness

Delete `agent/`, `.claude/`, and the agent workflow. Taskly and its normal CI keep working; tests the agent wrote are ordinary Vitest files.
