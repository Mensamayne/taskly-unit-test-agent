# Case order

Identify cases in this order and stop when the target lines are covered and the nearby negative paths are tested.

1. Happy path with typical valid input.
2. Guard clauses and invalid input (422, validation errors, early returns).
3. Branches: each side of every condition in the target lines.
4. Error paths: thrown errors, rejected promises, 404, null results.
5. Boundaries and empty states: limits (120 / 2000 characters), empty lists, null dates.
6. Async behavior: pending state, rejection, cancellation (abort signals).
7. Interactions with mocked dependencies at the module boundary: called with what, and not called when input is invalid.

## Structure

- One `describe` per unit under test when the file has more than a few cases.
- `it(...)` titles are complete sentences that state the behavior.
- One behavior per test. Arrange, act, assert.
- Table-driven cases (`it.each`) for input variations of the same behavior.

## Determinism

- No real network, database, filesystem writes, or timers. Mock `fetch`, use fake timers, inject fakes.
- Pin the clock with `vi.useFakeTimers()` and `vi.setSystemTime(...)` when code reads the current date.
- Do not depend on test order or shared mutable state; reset mocks in `beforeEach`.
