# Solution: unit-test agent for Taskly

A custom agent that writes and updates Vitest unit tests for the Taskly backend and frontend, verifies them by running them, and reports on GitHub pull requests.

| Piece | Location |
|-------|----------|
| Custom agents | `.claude/agents/unit-test-author.md`, `.claude/agents/test-reviewer.md` |
| Reusable skills | `.claude/skills/` |
| Harness (pipeline, gates, CLI, publisher) | `agent/`, see [`agent/README.md`](agent/README.md) |
| PR workflow | `.github/workflows/unit-test-agent.yml` |
| Edge cases and comparison with other agents | [`docs/edge-cases.md`](docs/edge-cases.md) |

| Line coverage | Before | After |
|---------------|--------|-------|
| Backend | 33.0% (48 tests) | 97.4% (96 tests) |
| Frontend | 47.7% (18 tests) | 97.6% (97 tests) |

Pull requests: [#1 harness](https://github.com/Mensamayne/taskly-unit-test-agent/pull/1), [#2 bootstrap tests](https://github.com/Mensamayne/taskly-unit-test-agent/pull/2), [#3 example feature](https://github.com/Mensamayne/taskly-unit-test-agent/pull/3), [#6](https://github.com/Mensamayne/taskly-unit-test-agent/pull/6) and [#7](https://github.com/Mensamayne/taskly-unit-test-agent/pull/7) hardening and verification.

## Main technical decisions

**A fixed pipeline with one agentic step.** A deterministic Node pipeline does everything that can be computed; the model only writes the test. A pipeline can guarantee scope, budgets, and verification; a free agent loop can only be asked to.

```
preflight -> diff -> baseline (suites, coverage, tsc) -> plan
  -> per target: author -> gates G0..G7 -> repair (max 2) -> accepted | rejected
  -> final suites -> report, test-only patch -> publish to the PR
```

**"When appropriate" is decided from data.** Per changed file, from the diff and the baseline coverage of the project's own Vitest config: `noop` (outside the coverage scope, or changed lines already covered), `repair-existing` (the PR broke its tests), `write` (no test file, or a new file), `update` (uncovered changed lines).

**Nothing the author claims is trusted.** The host runs acceptance gates on every result: no resubmitted failure (G0), only the target's test file changed (G1), static checks such as no `.only`/`.skip`, assertions in every test, no removed tests, no new dependencies, no unstubbed randomness (G2), no new `tsc` errors (G3), passes (G4), covers target lines (G6), passes three times in shuffled order (G5), full suite still green (G7). After every test run the worktree is checked again; side effects are reverted and fail the target. This is the TestGen-LLM / CoverUp filter: builds, passes, passes repeatedly, adds coverage. A failing assertion the author attributes to a source bug is dropped and reported as a suspected defect, never "repaired" into passing.

**Replaceable author.** `sdk` (Claude Agent SDK, default in CI), `external` (the CLI hands the same task packet to a person or another agent; refused in CI), `stub` (recorded output for tests). Same prompt, tools, budgets, and gates for all three.

**Least privilege.** The `author` job has the model key and a read-only token; every Vitest and `tsc` run happens in a Docker container without network or secrets; the harness and `.claude/` come from the base branch, so a PR cannot change the agent that reviews it. The `publish` job has a write token, never runs repository code, re-validates the test-only patch, checks the PR head did not move, commits, and keeps one updated PR comment.

**Small stack.** Plain Node ESM, no LangChain or LangGraph; two runtime dependencies (Agent SDK, zod); 43 harness tests, including end-to-end runs on real Vitest and `tsc`, the real Agent SDK against a scripted Messages API, and the Docker sandbox in CI.

## Running the PR workflow

Prerequisites:

1. Repository secret `ANTHROPIC_API_KEY` (without it the workflow skips the agent with a notice).
2. Settings, Actions, General: allow GitHub Actions to create pull requests (bootstrap mode).
3. Optional variables: `TEST_AGENT_MODE` (`commit` default, or `comment`), `TEST_AGENT_MODEL`.
4. GitHub-hosted `ubuntu-latest` runners (Docker preinstalled).

It runs automatically on pull requests that change `frontend/src/**` or `backend/src/**` (drafts and forks skipped), and manually ("Run workflow") in bootstrap mode, which covers files below 80% and opens a PR. Locally, see the CLI in [`agent/README.md`](agent/README.md); `--author external` needs no key.

## Custom agent and skills

`unit-test-author` writes tests for one source file per session. Tools: `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Skill`, and three task-scoped MCP tools served by the harness (`get_change_context`, `run_tests`, `coverage_for_file`); no shell, no web. A `PreToolUse` hook denies writes outside the target's test file. The final answer is a schema-checked JSON report (structured output). The harness reads the agent file and applies its prompt and tools to the SDK session, which runs with an isolated home directory. `test-reviewer` is read-only, runs after acceptance, and adds advisory notes.

| Skill | Used for |
|-------|----------|
| `diff-test-planning` | Case list from changed lines; expected values from intent, not from replaying the implementation |
| `backend-unit-tests` | Supertest with fake stores, Prisma delegate spies without a database, env stubs, Vitest pitfalls |
| `frontend-unit-tests` | Design-system mocks, hooks with a real `QueryClient`, `fetch` stubs, fake timers |
| `test-failure-triage` | Failure classes, test bug vs code bug, forbidden fixes |
| `test-quality-review` | The reviewer's checklist |

The task packet names the skills for each target; the same `SKILL.md` files work in CI and in a developer's Claude Code.

## Example run: PR #3

[PR #3](https://github.com/Mensamayne/taskly-unit-test-agent/pull/3) adds task statistics (`GET /api/todos/stats`, a `TodoStats` component, sort by title). On purpose, `computeStats` contained a defect (completed tasks counted as overdue, contrary to its documented contract), and the new component broke eight existing `TodosPage` tests.

| File | Decision | Skills | Outcome |
|------|----------|--------|---------|
| `TodosPage.tsx` | repair-existing | planning, frontend, triage | accepted; new child mocked, no assertion changed |
| `stats.ts` | write | planning, backend | **suspected defect** reported; test not committed |
| `TodoStats.tsx` | write | planning, frontend | accepted, 3/3 target lines |
| `router.ts` | update | planning, backend | accepted, 2/2 |
| `api/todos.ts` | update | planning, frontend | accepted, 1/1 |
| `useTodoStatsQuery.ts` | write | planning, frontend | accepted, 1/1 |
| `utils/todos.ts` | update | planning, frontend | accepted, 1/1 |

Seven files were `noop` with a reason each. Final verification: backend 92 and frontend 97 tests, no new type errors, "Tests passed". Six test files were committed to the PR with the status `unit-test-agent/verified` and the report as a PR comment. After the developer fixed the defect, a second run wrote the `stats.ts` tests (unchanged, written against the contract), which now passed and were committed; the same comment was updated.

[PR #2](https://github.com/Mensamayne/taskly-unit-test-agent/pull/2) is a bootstrap run: 20 of 20 targets accepted; its body is the agent's report.

These runs used the `external` driver with Claude Code as the author, because the repository has no model key yet: same packets, skills, tools, and gates as the `sdk` driver. The `sdk` driver is verified end to end against a scripted Messages API (`agent/test/sdk.e2e.test.mjs`), which found three wiring problems described in [`docs/edge-cases.md`](docs/edge-cases.md).

## Assumptions

- PR authors are collaborators; fork PRs get no secrets and are skipped.
- Unit tests need no database or network, and Vitest stays the only test framework.
- The base branch holds the trusted harness and agent configuration.
- Accepted tests still go through normal human review of the PR.

## Limitations

- No run with the real model yet: the SDK wiring is verified, the quality of model-written tests is not. The Docker sandbox runs on Linux only.
- Commits pushed with `GITHUB_TOKEN` do not retrigger CI; the publisher sets a commit status from the verified run instead.
- Coverage is a proxy: changed lines that existing tests execute are a `noop` even if the new behavior is not asserted. Gains are measured on lines, not branches.
- Static checks are regular expressions; a correctly named but wrong defect claim reaches the report (labeled unverified).
- USD limits are checked between model turns, so a session can exceed its allowance by one turn.
- Results are all or nothing per target; the PR comment shows the latest run only; targets per run are capped (8).

## What I would change for production

- A GitHub App identity, so CI reruns on the agent's commits and branch protection can require them.
- Mutation testing (for example Stryker) as an extra value gate; branch-aware coverage gains.
- Run history across pushes in the PR comment; parallel targets; baseline cache per base commit.
- An evaluation set of past PRs to measure changes to prompts, skills, or models; cost dashboards from `run.json`.

## Removing the agent

Delete `agent/`, `.claude/`, `docs/edge-cases.md`, and `.github/workflows/unit-test-agent.yml`, and remove the harness job from `ci.yml`. Taskly keeps working; the tests the agent wrote are ordinary Vitest files.
