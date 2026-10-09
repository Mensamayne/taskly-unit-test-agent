import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/factory.ts';
import type { Database } from '../src/features/todos/types.ts';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const database = {
    todo: {
      findFirst: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { database, app: createApp(database as unknown as Database) };
}

describe('createApp', () => {
  it('serves the health check through the database', async () => {
    const { app, database } = setup();
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(database.todo.findFirst).toHaveBeenCalledOnce();
  });

  it('mounts the todos router under /api/todos', async () => {
    const { app, database } = setup();
    const response = await request(app).get('/api/todos');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(database.todo.findMany).toHaveBeenCalledOnce();
  });

  it('does not reveal the framework in response headers', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('serves the OpenAPI specification as JSON', async () => {
    const { app } = setup();
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('openapi');
    expect(response.body).toHaveProperty('paths');
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/unknown');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: 'Not Found' });
  });

  it('rejects malformed JSON with 422', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/todos').set('Content-Type', 'application/json').send('{"title":');
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ detail: 'Invalid JSON.' });
  });

  it('rejects oversized request bodies with 413', async () => {
    const { app } = setup();
    const response = await request(app).post('/api/todos').send({ title: 'x'.repeat(200 * 1024) });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ detail: 'Request body too large.' });
  });

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    const { app, database } = setup();
    const failure = new Error('database unavailable');
    database.todo.findFirst.mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ detail: 'Internal Server Error' });
    expect(log).toHaveBeenCalledWith(failure);
  });
});
