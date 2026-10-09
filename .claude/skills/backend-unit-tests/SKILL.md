---
name: backend-unit-tests
description: Write or extend Vitest unit tests for the Taskly backend (Express 5, Prisma 7, zod 4) under backend/tests. Use for routers, repositories, validators, mappers, app factory, config, and startup code.
---

# Backend unit tests

Taskly backend tests are fast unit tests: no PostgreSQL, no network, no real server. Follow the patterns already in `backend/tests/` so new tests read like the existing ones.

## Layout and conventions

- Tests live flat in `backend/tests/<module>.test.ts` (for example `src/features/todos/router.ts` -> `tests/router.test.ts`).
- Import sources with the `.ts` extension: `import { createApp } from '../src/factory.ts';`.
- Import Vitest helpers explicitly: `import { describe, expect, it, vi } from 'vitest';`.
- Style: semicolons, single quotes, 2-space indent, compact tests like the existing files.
- Shared fixture: `backend/tests/fixture.ts` exports `record` (a Prisma row) and `todo` (the API shape). Reuse it; do not edit it.
- Run: `npm test` in `backend/` (`vitest run`). Type-check: `npm run typecheck` (tests are included).

## Patterns

Pick the seam that matches the unit. Code for each is in [references/patterns.md](references/patterns.md).

| Unit | Seam |
|------|------|
| `features/todos/router.ts` | Small Express app + Supertest, fake `TodoStore` built from `vi.fn()` |
| `features/todos/repository.ts` | Real Prisma client from `createDatabase('postgresql://test:test@localhost:5432/test')`, then `vi.spyOn(database.todo, 'findMany')` etc. No connection is opened. |
| `features/todos/validators.ts` | Direct `schema.parse` / `safeParse`, table-driven with `it.each` |
| `features/todos/mappers.ts` | Pure function, compare to `todo` fixture |
| `factory.ts` | `createApp(fakeDatabase)` + Supertest; fake only the Prisma delegate methods the request touches |
| `api/health.ts` | Router + fake database with `todo.findFirst` |
| `core/config.ts` | `vi.stubEnv(...)` per case, `vi.unstubAllEnvs()` after each |
| `core/database.ts` | Fake object with `$executeRaw: vi.fn()` |
| `core/lifespan.ts` | `vi.mock` the database, config, and factory modules; fake `listen`; capture `process.once` handlers with `vi.spyOn` |

## Rules

1. Mock at module boundaries (`vi.mock('../src/core/database.ts', ...)`, injected fakes). Never mock the unit under test.
2. Express 5 forwards rejected promises from async handlers to the error handler; test 500 paths by making a fake reject.
3. When a module is mocked with `vi.mock` factories, call `vi.clearAllMocks()` in `beforeEach`. `vi.restoreAllMocks()` only restores `vi.spyOn` spies; it does not reset call history of `vi.fn()` created in a factory (Vitest 4).
4. Cast fakes at the boundary with `as unknown as Database` (or `ReturnType<typeof fn>`), never `as any`.
5. Silence expected `console.error` / `console.log` with `vi.spyOn(console, 'error').mockImplementation(() => {})` and assert on it when the log is the behavior.
6. Restore process state you touch: `process.exitCode = undefined`, `vi.unstubAllEnvs()`.
7. Do not edit `backend/src/**`, `backend/tests/fixture.ts`, `vitest.config.ts`, or `package.json`. New helpers go inside the test file.

## Checklist before finishing

- Every new `it` asserts something observable (status, body, return value, call arguments).
- Negative paths assert that the dependency was not called.
- The file passes `npm test -- tests/<file>.test.ts` and `npm run typecheck`.
