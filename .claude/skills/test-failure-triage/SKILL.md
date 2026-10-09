---
name: test-failure-triage
description: Diagnose a failing or rejected Taskly unit test and decide whether the test or the source is wrong. Use when a test run, typecheck, or acceptance gate reports a failure for a test you wrote or must repair.
---

# Test failure triage

A failure is information. The goal is a correct test, not a green one. Read the failure class first, then follow its procedure.

## Failure classes

| Class | Typical message | First move |
|-------|-----------------|-----------|
| `typecheck` | `TS2345: Argument of type ...` | Fix types in the test: correct imports, fixture shapes, `as unknown as T` at mock boundaries |
| `runtime` | `Cannot find module`, `is not a function`, error thrown before assertions | Check import paths (`.ts` extension in backend), mock factory shape, hoisting of `vi.mock` |
| `assertion` | `expected X to be Y`, `toHaveBeenCalledWith` mismatch | Decide test bug or code bug (below) |
| `timeout` | `Test timed out in 5000ms` | Missing `await`, unresolved promise in a mock, fake timers not advanced, `findBy` waiting for text that never renders |
| `flaky` | Passes alone, fails on repeat or in shuffled order | Shared state between tests: reset mocks, timers, env, globals in `beforeEach`/`afterEach` |
| `no-gain` | Tests pass but cover none of the target lines | The tests exercise the wrong path; re-read the target lines and drive input that reaches them |
| `pollution` | The new file breaks other tests in the suite | Global state leaked: restore stubs, timers, env, `process` properties |
| `static` | `.only`, missing assertion, removed existing test, unresolved import | Remove the marker, add a real assertion, restore the removed test, use only installed packages |

## Test bug or code bug

For an `assertion` failure:

1. Re-derive the expected value from intent, not from the implementation: schema, API contract, UI copy, function name, the change being tested.
2. If your expectation was wrong (misread contract, wrong fixture value, wrong label), fix the test.
3. If the intent is clear and the source contradicts it, the source is probably wrong. Keep the assertion, stop changing the test, and report a suspected defect with: the test title, what the intent says, what the code does.
4. If intent is genuinely ambiguous, assert only what is certain and list the ambiguity under `notCovered`.

## Forbidden fixes

- Changing an expected value to whatever the code returned, without a reason from intent.
- Deleting, skipping (`.skip`, `.todo`), or focusing (`.only`) tests.
- `as any`, `@ts-ignore`, or `@ts-nocheck` to silence the type checker.
- Mocking the unit under test, or mocking so much that the test only checks the mock.
- Wrapping assertions in `try/catch`, or asserting `toBeDefined()` where a value is known.
- Editing production code, fixtures, setup files, or configuration.

## Repairing existing tests broken by a change

Only update an existing assertion when the change under review explains it (for example, a default value or message intentionally changed). For each one, record the test title and the reason. Never remove a test because it fails.
