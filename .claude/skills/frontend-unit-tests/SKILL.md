---
name: frontend-unit-tests
description: Write or extend Vitest + React Testing Library unit tests for the Taskly frontend (React 19, TanStack Query, styled-components design system). Use for components, hooks, API clients, and utilities under frontend/src.
---

# Frontend unit tests

Tests sit next to the unit (`TodoList.tsx` -> `TodoList.test.tsx`), run in jsdom, and are type-checked by `tsc` together with production code (`npm run build` fails on a broken test). Follow the existing tests in `frontend/src`.

## Layout and conventions

- `*.test.tsx` for components and hooks that render, `*.test.ts` for plain modules.
- Import Vitest helpers explicitly: `import { describe, expect, it, vi } from 'vitest'`.
- Style (Prettier): no semicolons, single quotes, trailing commas, 2-space indent, 80 columns. The host formats the test file with the project Prettier config before checks.
- Setup: `src/test/setup.ts` adds jest-dom matchers and cleanup. Do not edit it.
- Fixture: `src/test/todoFixture.ts` exports `todoFixture` (a full `Todo`). Spread and override it.
- Run: `npm test` in `frontend/`. Type-check: `npm run typecheck`.

## Patterns

Code for each is in [references/patterns.md](references/patterns.md).

| Unit | Seam |
|------|------|
| Components using the design system | `vi.mock('<relative path>/design-system', () => import('<relative path>/design-system/mocks'))` |
| Components composed of feature components | Mock child components and hooks by module path, assert on props passed or rendered text |
| Query and mutation hooks (`features/todos/hooks`) | `renderHook` with a real `QueryClient` (`retry: false`) in a wrapper; mock `../api/todos` |
| API client (`features/todos/api/todos.ts`) | Mock `../../../lib/http` `request` and assert the path and init |
| `lib/http.ts` | `vi.stubGlobal('fetch', vi.fn())` returning `new Response(...)` |
| `hooks/useNotice.ts` and date logic | `vi.useFakeTimers()`, `vi.setSystemTime(...)`, `act(() => vi.advanceTimersByTime(...))` |
| Pure utilities (`utils/todos.ts`) | Direct calls, `it.each` tables |

## Design system mocks

The real components are styled-components that need a theme provider. The mocks in `src/design-system/mocks.tsx` render plain elements:

- `Alert` -> `<div data-testid="alert">`
- `Drawer` -> `<div role="dialog" aria-label={title}>` with a Close button, only when `isOpen`
- `Input` / `Select` -> `<label>{label}<input|select/></label>`, so `getByLabelText(label)` works; `error` renders as text
- `Button`, `IconButton` -> `<button>`; `Heading` -> `<h1..h6>`; `Text` -> `<p>` or `as`
- Every mock is a `vi.fn`, so `vi.mocked(Alert).mock.calls[0][0]` exposes props

## Rules

1. Query by role, label, and text (`getByRole('button', { name: 'Save task' })`). Use `getByTestId('alert')` only for the alert mock.
2. Use `userEvent.setup()` and `await user.click(...)` for interactions.
3. Await async UI with `findBy...` or `await waitFor(...)`; do not sleep.
4. Mutation hook mocks return objects cast as `as unknown as ReturnType<typeof useX>`, never `as any`.
5. Reset mocks in `beforeEach(() => vi.clearAllMocks())` when module mocks are shared across tests.
6. Restore globals: `vi.unstubAllGlobals()`, `vi.useRealTimers()` in `afterEach`.
7. Dates: `formatDate` uses `en-GB` (`15 Oct 2026`), `isOverdue` compares with the local date; pin the clock.
8. Do not edit production files, `src/test/*`, `vite.config.ts`, or `package.json`. Helpers go inside the test file.

## Checklist before finishing

- The test file compiles under `tsc` (unused imports and wrong prop types fail the build).
- Each test asserts visible output, callback calls, or cache state, not internal component state.
- The file passes `npm test -- src/<path>.test.tsx`.
