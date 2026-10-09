import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createHealthRouter } from '../src/api/health.ts';
import type { Database } from '../src/features/todos/types.ts';

function setup(findFirst = vi.fn().mockResolvedValue(null)) {
  const app = express();
  app.use('/api', createHealthRouter({ todo: { findFirst } } as unknown as Database));
  app.use(((error, req, res, next) => res.status(500).json({ detail: (error as Error).message })) as express.ErrorRequestHandler);
  return { app, findFirst };
}

describe('health router', () => {
  it('reports ok after a minimal database query, even with an empty table', async () => {
    const { app, findFirst } = setup();
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
  });

  it('does not report ok when the database is unreachable', async () => {
    const { app } = setup(vi.fn().mockRejectedValue(new Error('connection refused')));
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ detail: 'connection refused' });
  });
});
