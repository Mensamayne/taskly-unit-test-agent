# Unit-test agent: edge cases

Companion to [`SOLUTION.md`](../SOLUTION.md). How the harness behaves when a written test cannot pass, cheats, or the environment fails, and how other unit-test agents handle the same problems.

## Cases exercised

The harness was driven from the author's side with tests made to fail, hang, cheat, and break the environment. Each case was run for real through the CLI; "fixed" marks cases that were handled wrongly before this review. The fixes are covered by `agent/test/`.

| Case | Behavior | Status |
|------|----------|--------|
| Syntax error in the test | G3 reports the `tsc` error with file and line; repair | as designed |
| Test imports a module that does not exist | G2 rejects before running anything | as designed |
| Author writes no file, or a file without tests | G1 / G2, repair | as designed |
| Invalid self-report, or `gate` before `submit` | Typed CLI error, state unchanged | as designed |
| Author exhausts `run_tests` | Budget error from the tool; host gates still run | as designed |
| Test calls `process.exit` | Vitest intercepts it; runtime failure with the message | as designed |
| Test writes to a production file while running | Was **accepted**. Now every test run is followed by a worktree check; the file is reverted and the target fails with `side-effect` | fixed |
| Flaky test (`Math.random`) resubmitted until it passes | Was **accepted** on the third try. Now G2 rejects unstubbed randomness, and a resubmitted file that already failed is rejected without running (G0) | fixed |
| Repair that fails exactly like the previous attempt | Used to spend the next repair. Now stops the target early (no progress) | fixed |
| Test hangs on a promise | Reported as "STACK_TRACE_ERROR", class runtime. Now class `timeout` with an actionable message | fixed |
| Synchronous infinite loop | Command timeout; the whole process tree is killed (process group on Linux, `taskkill /T` on Windows) and the container is stopped by name | fixed; container path tested in CI (`agent/test/docker.e2e.test.mjs`) |
| Vitest or `tsc` cannot run at all | Was charged to the author as a test failure. Now class `infra`: retried once, then "not verified", never a repair | fixed |
| Author claims a defect for a failure it caused | Claims must name a test that failed on an assertion; the report labels them as unverified | partly fixed (a correctly named but wrong claim still reaches the report, labeled) |
| Two sources with the same file name (flat backend tests) | The second one is a `noop` instead of two authors overwriting one file | fixed |
| Path with `..` in a patch header (`backend/tests/../src/x.test.ts`) | Passed the raw allowlist check used by the publisher. Now rejected | fixed |
| PR breaks existing tests | Baseline keeps coverage (`reportOnFailure`); the target becomes `repair-existing` | fixed |
| Aborted or failed run | Report said "no source changes". Now "Could not verify the result: the run failed (code)" | fixed |
| Author cannot see what changed | The task packet includes the unified diff of the file, not only line numbers | fixed |

## Agent SDK wiring

A scripted stand-in for the Messages API (`agent/test/support/fake-anthropic.mjs`) runs the real Agent SDK and Claude Code process without a model. It exposed three problems that would have appeared only with a key:

- The SDK's `agent` option (version 0.3.282) replaced the tool list with the agent's and dropped the Skill and StructuredOutput tools; the agent prompt did not reach the request. The harness now reads `.claude/agents/<name>.md` and passes prompt and tools itself.
- The agent process read the user's `~/.claude` (memory, settings, user skills). It now gets an isolated home directory per run.
- `ANTHROPIC_BASE_URL` was not forwarded to the agent process.

## Runs that failed during development

- Two runs failed on G1 (scope): while authoring one target, the author touched another target's file (once by reformatting an accepted file, once by writing the next target's file early). The whole run was rejected and replayed. The harness now formats frontend test files itself before the gates.
- A PR that broke existing tests could not be planned, because Vitest skips the coverage report when tests fail.
- A new helper covered only indirectly (through a router test) was planned as `noop`. Every new file now gets its own tests.

## Comparison with other unit-test agents

Read from their source code.

| Problem | CoverUp | ai-git-bot | unit-test-agent-4j | This harness |
|---------|---------|------------|--------------------|--------------|
| Hanging test | 60 s timeout, then gives up the segment | Tool timeout | Timeout failure type | Command timeout, tree kill, typed `timeout` |
| Flaky test | `--repeat-tests` | One whole-suite retry (can hide flakiness) | Not handled | Shuffled repeats, randomness check, no resubmission |
| State pollution | `--isolate-tests`, can disable polluters | Not handled | Not handled | Full-suite gate, file isolation, side-effect revert |
| Infra vs test failure | Separate timeout path | `ERROR` vs `FAILED` outcome | Failure taxonomy | `infra` class, retried, never charged to the author |
| Endless repair | `--max-attempts` | Retry budget | Per-test cap, stagnation detection | Max 2 repairs, no-progress stop |
| Path traversal | n/a | Guard does not normalize `..` | Project-root sandbox | Normalized hook, segment check on raw patch paths |
| Missing dependency | Optionally installs it | n/a | Dependency failure type | Rejected at G2, never installed |
