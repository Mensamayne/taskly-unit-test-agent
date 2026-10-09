---
name: diff-test-planning
description: Plan unit test cases for one changed or under-covered Taskly source file. Use before writing or extending any Vitest test, when you know the source file and the lines that need coverage.
---

# Diff test planning

Turn "this file changed and these lines are not covered" into a short, ordered list of test cases worth writing. Planning comes before code: a test file written without a plan tends to mirror the implementation.

## Inputs

- The source file and the lines to cover (from the task packet or `uta tool change-context`).
- The existing test file for that source, if any, and one neighboring test as a style reference.

## Steps

1. Read the whole source file, not only the changed lines. Note its public surface: exported functions, components, routes, hooks.
2. Read the existing test file. List what it already covers so you do not duplicate it.
3. For each line range to cover, name the behavior it implements in one sentence ("PATCH returns 404 when the task does not exist"). Lines are a pointer to behavior, not the goal.
4. Order cases with [references/case-order.md](references/case-order.md) and drop cases that add nothing over an existing test.
5. Decide the seam for each case: what is real, what is mocked, and where the mock sits (module boundary only).
6. Write the cases as `it(...)` titles first, as complete sentences, then implement them.

## The oracle rule

Expected values come from the intent of the code: names, types, validation schemas, API contracts, UI copy, and the change itself. Do not compute expected values by re-running the implementation in your head and copying what it produces. If the intent and the implementation disagree, the test should assert the intent and fail; report it as a suspected defect instead of adjusting the assertion.

Useful sources of intent in Taskly:

- Backend validation: `backend/src/features/todos/validators.ts` (zod schemas) and `backend/openapi.json`.
- Frontend copy and labels: the strings rendered by the component under test.
- Field limits shared by both sides: title 1-120 characters, description up to 2000, priority `low|medium|high`, `due_date` as `YYYY-MM-DD` or null.

## What not to test

- Re-exports (`index.ts`), types, styles, constants, Storybook stories, the design system itself.
- Framework behavior (that Express parses JSON, that React renders a prop).
- Private helpers through anything other than the public unit that uses them.
- Exact log text or call order unless the behavior depends on it.

## Output of planning

A list like:

```
backend/src/features/todos/router.ts, lines 25-29 (PATCH /:id)
1. updates a task with validated, trimmed fields          (happy path)
2. rejects an empty patch with 422 without calling the repository  (guard)
3. returns 404 when the repository reports a missing task  (error path)
```

Keep it to the cases that cover the target lines and the obvious negative paths next to them. More tests are not better tests.
