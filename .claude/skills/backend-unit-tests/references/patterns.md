# Backend test patterns

## Router with a fake store

```ts
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createTodosRouter } from '../src/features/todos/router.ts';
import { todo } from './fixture.ts';

function setup() {
  const repository = { list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}

it('returns 404 when the task does not exist', async () => {
  const { app, repository } = setup();
  repository.get.mockResolvedValue(null);
  const response = await request(app).get('/api/todos/9');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Task not found.' });
});
```

## Repository with a spied Prisma delegate

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/core/database.ts';
import { TodoRepository } from '../src/features/todos/repository.ts';
import { record, todo } from './fixture.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  // Real Prisma client object; IO is mocked, no connection is opened.
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  return { database, repository: new TodoRepository(database) };
}

it('maps rows returned by the database', async () => {
  const { database, repository } = setup();
  vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
  expect(await repository.list()).toEqual([todo]);
});
```

## App factory with a fake database

```ts
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/factory.ts';
import type { Database } from '../src/features/todos/types.ts';

function setup() {
  const database = { todo: { findFirst: vi.fn().mockResolvedValue({ id: 1 }), findMany: vi.fn().mockResolvedValue([]) } };
  return { database, app: createApp(database as unknown as Database) };
}

it('answers unknown routes with a JSON 404', async () => {
  const { app } = setup();
  const response = await request(app).get('/api/unknown');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Not Found' });
});
```

Malformed JSON: `request(app).post('/api/todos').set('Content-Type', 'application/json').send('{"title":')` -> 422.
Oversized body (express.json default limit 100 kB): send a 200 kB string -> 413.

## Environment-driven config

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../src/core/config.ts';

afterEach(() => vi.unstubAllEnvs());

it('reports the first missing variable', () => {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('POSTGRES_USER', '');
  expect(() => resolveDatabaseUrl()).toThrow('Missing environment variable: POSTGRES_USER');
});
```

`config.ts` loads the repository `.env` on import. Stub every variable a case depends on, including clearing `DATABASE_URL`, so a developer's local `.env` cannot change the result.

## Mocked modules

```ts
vi.mock('../src/core/database.ts', () => ({ createDatabase: vi.fn(), initialize: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
```

`vi.mock` is hoisted above imports. Import the mocked functions normally and configure them with `vi.mocked(fn).mockReturnValue(...)`.
