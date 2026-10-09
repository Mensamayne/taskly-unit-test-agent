# Solution: unit-test agent for Taskly

A custom agent that writes and updates unit tests for Taskly, runs them, and reports on GitHub pull requests. It covers the backend (Express, Prisma, zod) and the frontend (React, TanStack Query), both on Vitest.

| Piece | Location |
|-------|----------|
| Custom agents | `.claude/agents/unit-test-author.md`, `.claude/agents/test-reviewer.md` |
| Reusable skills | `.claude/skills/` (five skills, below) |
| Harness: pipeline, gates, CLI, publisher | `agent/` (see `agent/README.md`) |
| PR workflow | `.github/workflows/unit-test-agent.yml` |
| Regular CI | `.github/workflows/ci.yml` |

Results on this repository:

| | Before | After |
|-|--------|-------|
| Backend line coverage | 33.0% (48 tests) | 97.4% (96 tests) |
| Frontend line coverage | 47.7% (18 tests) | 97.6% (97 tests) |

Pull requests: [#1 harness](https://github.com/Mensamayne/taskly-unit-test-agent/pull/1), [#2 bootstrap tests](https://github.com/Mensamayne/taskly-unit-test-agent/pull/2), [#3 example feature with the agent's results](https://github.com/Mensamayne/taskly-unit-test-agent/pull/3), [#4 harness fixture fix](https://github.com/Mensamayne/taskly-unit-test-agent/pull/4).

## Main technical decisions

**A fixed pipeline with one agentic step.** The agent does not roam the repository. A deterministic Node pipeline does everything that can be computed, and the model fills only the step that needs judgment: writing the test.

```
preflight -> diff -> baseline (suites, coverage, tsc) -> plan
  -> per target: author -> gates G1..G7 -> repair (max 2) -> accepted | rejected
  -> final suites -> report, test-only patch -> publish to the PR
```

Rationale: the brief weighs security, reliability, and correct results. A pipeline can guarantee scope, budgets, and verification; a free agent loop can only be asked to.

**"When appropriate" is decided from data, not by the model.** For each changed file the planner reads the diff (changed line numbers) and the baseline coverage of the project's own Vitest configuration:

| Situation | Decision |
|-----------|----------|
| Not in the coverage scope (types, styles, re-exports, design system) | `noop` |
| Existing tests for the file fail on the PR head | `repair-existing` |
| New file without its own test file | `write` |
| Changed lines not covered by passing tests | `update` or `write` |
| Changed lines already covered | `noop` |

**Nothing the author claims is trusted.** Every result goes through acceptance gates run by the host:

| Gate | Check |
|------|-------|
| G1 scope | Only the target's test file changed anywhere in the worktree. Any other change fails the whole run. |
| G2 static | No `.only/.skip/.todo`, `@ts-ignore`, `as any`; every test asserts; no existing test removed; imports resolve without new dependencies |
| G3 typecheck | No new `tsc` errors (frontend tests are part of `npm run build`) |
| G4 pass | The test file passes |
| G6 value | The test file alone covers at least one target line |
| G5 stable | Three passes in shuffled order |
| G7 suite | No new failures in the full package suite |

This follows the acceptance filter used by Meta's TestGen-LLM and CoverUp: builds, passes, passes repeatedly, adds coverage. A failing assertion that the author attributes to a bug in the source is not "repaired" into passing: the test is dropped from the patch and reported as a suspected defect.

**Replaceable author.** The authoring step is a port with three drivers:

- `sdk`: Claude Agent SDK, one session per target, the custom agent and skills from `.claude/`. Default in CI.
- `external`: the CLI hands the same task packet to whoever drives it (a person, Cursor, Claude Code) and waits for `uta submit`. Refused in CI.
- `stub`: replays recorded output; used by the harness tests.

All three get the same prompt (rendered once in `agent/src/packet.mjs`), the same tools, the same budgets, and the same gates. This made it possible to develop and verify the whole flow step by step from the command line.

**Least privilege in the workflow.** Two jobs:

- `author`: holds the model key and a read-only token, runs repository code. Every Vitest and `tsc` run happens in a Docker container with no network, no secrets, and resource limits. The harness and `.claude/` are checked out from the base branch, so a PR cannot change the agent that reviews it (`projectConfigRoot` in the SDK).
- `publish`: holds a write token and never runs repository code. It re-validates the patch (only allowlisted test paths, no renames, deletions, mode changes, or binaries), checks the PR head did not move, applies it with `git apply`, commits, and updates a single PR comment.

**No framework beyond the SDK.** Plain Node ESM, no LangChain or LangGraph. The harness has two runtime dependencies (the Agent SDK and zod) and its own test suite (`node --test`).

## Running the PR workflow

Prerequisites:

1. Repository secret `ANTHROPIC_API_KEY`. Without it the workflow skips the agent with a notice instead of failing.
2. Settings, Actions, General: "Allow GitHub Actions to create and approve pull requests" (bootstrap mode opens a PR).
3. Optional repository variables: `TEST_AGENT_MODE` (`commit`, the default, or `comment`), `TEST_AGENT_MODEL` (default `claude-sonnet-5-5`).
4. GitHub-hosted `ubuntu-latest` runners (Docker is preinstalled).

Triggers:

- Automatically on pull requests that change `frontend/src/**` or `backend/src/**` (opened, synchronize, reopened, ready for review; drafts and fork PRs are skipped).
- Manually (Actions, "Unit test agent", Run workflow) for bootstrap mode, which targets files below 80% line coverage and opens a PR with the tests.

Locally, with dependencies installed in `backend/` and `frontend/`:

```sh
node agent/src/cli.mjs run --mode pr --base origin/main --author external
node agent/src/cli.mjs packet --target t1        # the prompt the author receives
node agent/src/cli.mjs tool run-tests --target t1
node agent/src/cli.mjs submit --target t1 --result result.json
node agent/src/cli.mjs gate --target t1
node agent/src/cli.mjs resume
node agent/src/publish.mjs --identity local --run .uta-runs/<run id> --repo <owner>/<repo> --pr <n> --workspace .
```

With `ANTHROPIC_API_KEY` set, `--author sdk` runs the same flow with the Claude agent.

## Custom agent and skills

`unit-test-author` (`.claude/agents/unit-test-author.md`) writes tests for exactly one source file per session. Its tools are `Read`, `Grep`, `Glob`, `Write`, `Edit`, and three task-scoped MCP tools served in process by the harness: `get_change_context`, `run_tests` (sandboxed, budgeted), and `coverage_for_file`. It has no shell and no web access. A `PreToolUse` hook (in process for the SDK, and `.claude/settings.json` for Claude Code) denies writes outside the target's test file and reads of `.env` files. The final answer is forced into a JSON schema through structured output.

`test-reviewer` (`.claude/agents/test-reviewer.md`) is read-only and runs after a target is accepted. Its findings (tautologies, over-mocking, weak assertions) appear in the report as advisory notes and never block.

Skills (`.claude/skills/`), loaded on demand; the task packet tells the author which ones apply:

| Skill | Used for |
|-------|----------|
| `diff-test-planning` | Turning changed or uncovered lines into a case list; the rule that expected values come from intent, not from replaying the implementation |
| `backend-unit-tests` | Supertest with a fake store, spying on the Prisma delegate without a database, `vi.stubEnv`, mocked modules, Vitest 4 pitfalls |
| `frontend-unit-tests` | Design-system mocks, hooks with a real `QueryClient`, `fetch` stubs, fake timers, Prettier and `tsc` constraints |
| `test-failure-triage` | Failure classes, deciding test bug vs code bug, forbidden "fixes" |
| `test-quality-review` | The reviewer's checklist |

The skills are plain `SKILL.md` files. The same files serve the SDK agent in CI and a developer using Claude Code locally.

## Example run

### Pull request #3: task statistics

[PR #3](https://github.com/Mensamayne/taskly-unit-test-agent/pull/3) adds `GET /api/todos/stats`, a `TodoStats` component, and a "sort by title" option. Two things were set up on purpose to exercise the agent: `computeStats` contained a planted defect (completed tasks counted as overdue, contrary to its documented contract), and adding `TodoStats` to the page broke eight existing `TodosPage` tests.

Run 1 (`pr-20261009-152049`), plan:

| File | Decision | Skills in the packet | Outcome |
|------|----------|----------------------|---------|
| `frontend/src/features/todos/TodosPage.tsx` | repair-existing | diff-test-planning, frontend-unit-tests, test-failure-triage | accepted: the new child component is mocked; no existing assertion changed |
| `backend/src/features/todos/stats.ts` | write | diff-test-planning, backend-unit-tests | **suspected defect**: "never counts completed tasks as overdue" fails; test dropped and reported |
| `frontend/src/features/todos/components/TodoStats.tsx` | write | diff-test-planning, frontend-unit-tests | accepted, 3/3 target lines |
| `backend/src/features/todos/router.ts` | update | diff-test-planning, backend-unit-tests | accepted, 2/2 |
| `frontend/src/features/todos/api/todos.ts` | update | diff-test-planning, frontend-unit-tests | accepted, 1/1 |
| `frontend/src/features/todos/hooks/useTodoStatsQuery.ts` | write | diff-test-planning, frontend-unit-tests | accepted, 1/1 |
| `frontend/src/features/todos/utils/todos.ts` | update | diff-test-planning, frontend-unit-tests | accepted, 1/1 |

Seven files were `noop` with a reason each (types and query keys outside the coverage scope, `styles.css`, the mutation hooks whose changed lines were already covered). Final verification: backend 92 tests, frontend 97 tests, no new type errors: "Tests passed". The publisher committed six test files to the PR, set the commit status `unit-test-agent/verified`, and posted the report as a PR comment.

The developer then pushed the fix for the reported defect. Run 2 (`pr-20261009-152601`) planned one target, `stats.ts` (`write`, new file without its own test file). The test written against the contract now passed all gates and was committed; the same PR comment was updated.

### Pull request #2: bootstrap

[PR #2](https://github.com/Mensamayne/taskly-unit-test-agent/pull/2) is a bootstrap run over both packages: 20 of 20 targets accepted, 0 repairs needed in the final run, coverage numbers in the table at the top. The PR body is the agent's report.

### Runs that failed, and why

Kept on purpose, because they show the gates working:

- Two runs failed on G1 (scope): while authoring one target, the author touched a file that belonged to another target (once by reformatting an accepted file, once by writing the next target's file early). The whole run was rejected and replayed. As a consequence the harness now formats frontend test files itself before the gates.
- On a PR whose changes broke existing tests, the first baseline failed because Vitest skips the coverage report when tests fail. Fixed with `--coverage.reportOnFailure` and covered by an e2e test.
- A new helper covered only indirectly (through a router test) was planned as `noop`. The planner now gives every new file its own tests.

### Who authored the tests in these runs

The repository has no model key yet, so the runs above used the `external` driver, with Claude Code driving the CLI as the author. It received the same task packets, loaded the same skill files, used the same tools, and passed the same gates as the `sdk` driver. The `sdk` driver itself (`agent/src/author/sdk.mjs`) is written against the Agent SDK 0.3.282 type definitions but has not yet run against the API in this repository.

## Assumptions

- Pull request authors are repository collaborators. Fork PRs are skipped because they get no secrets.
- Unit tests need no database or network; the existing tests already follow this.
- Vitest stays the only test framework; the agent never adds dependencies.
- The base branch holds the trusted version of the harness and the agent configuration.
- A test that covers the target lines, passes repeatedly, and asserts intended behavior is worth committing; the human reviewer still reviews the PR.

## Limitations

- The `sdk` driver and the Docker sandbox have not been exercised end to end here (no model key). The harness tests cover the pipeline with the `stub` and `external` drivers on real Vitest and `tsc`.
- Commits pushed with `GITHUB_TOKEN` do not trigger other workflows, so CI does not rerun on the agent's commit. The publisher sets a commit status from the verified run instead.
- Coverage is a proxy for value. A changed line that existing tests execute is a `noop` even if no test asserts the new behavior (in PR #3 the cache invalidation added to the mutation hooks is executed but not asserted).
- Static checks are regular expressions: fast and conservative, not a parser.
- Per target, results are all or nothing. A test file with one wrong test and five good ones is rejected after two repairs.
- The PR comment shows the latest run only; earlier findings remain in the commit history and workflow artifacts.
- For same-repository PRs, the workflow file itself comes from the PR branch, as with any GitHub workflow. Collaborators with write access are trusted with workflows anyway.
- Targets per run are capped (8 by default), so a very large PR is covered over several pushes.

## What I would change for production

- A GitHub App identity for the publisher, so CI reruns on the agent's commits and branch protection can require them.
- Mutation testing (for example Stryker) as an additional value gate for accepted tests.
- Keep run history across pushes (suspected defects, rejected targets) in the comment marker, and retry targets whose source changed since a rejection.
- Run independent targets in parallel and cache the baseline per base commit.
- An evaluation set of past PRs replayed through the pipeline to measure changes to prompts, skills, or models before rolling them out.
- Cost and outcome dashboards from `run.json` artifacts.
- A TypeScript AST for the static checks instead of regular expressions.

## Removing the agent

Delete `agent/`, `.claude/`, and `.github/workflows/unit-test-agent.yml`, and remove the harness job from `ci.yml`. Taskly and its CI keep working; the tests the agent wrote are ordinary Vitest files.
