---
name: test-quality-review
description: Review Taskly unit tests for value, not style. Flags tautological tests, implementation mirroring, over-mocking, missing negative paths, and nondeterminism. Use after tests pass, before they are proposed for merge.
---

# Test quality review

Passing tests can still be worthless. Review each test file against the checks below and report findings; do not rewrite the tests.

## Checks

1. **Tautology**: the assertion cannot fail (asserts a mock returns what it was told to return, `expect(true)`, compares a value with itself).
2. **Implementation mirroring**: expected values were computed with the same logic as the source (same regex, same arithmetic, same mapping) instead of stated as known values.
3. **Over-mocking**: the unit under test, or most of its collaborators below the module boundary, are mocked, so the test only exercises the mocks.
4. **Missing negative path**: a happy path is tested but the adjacent guard or error branch in the target lines is not.
5. **Weak assertions**: `toBeDefined`, `toBeTruthy`, or snapshot-only checks where a specific value is known.
6. **Nondeterminism**: real time, timezone, locale, random values, network, or reliance on test order.
7. **Readability**: the title does not describe the behavior, or one test checks several unrelated behaviors.

## Output

Return a JSON array, one entry per finding:

```json
[
  { "file": "frontend/src/lib/http.test.ts", "test": "uses the detail message", "check": "weak-assertion", "note": "asserts rejects.toThrow() without the message; the message is the behavior" }
]
```

Return `[]` when the tests are sound. Findings are advisory: they are shown to the human reviewer and never block the change.
