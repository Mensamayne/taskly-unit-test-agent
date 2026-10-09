import express from 'express';
import request from 'supertest';
import { afterEach, it, expect, vi } from 'vitest';
import { createTodosRouter } from '../src/features/todos/router.ts';
import { todo } from './fixture.ts';

function setup() {
  const repository = { list: vi.fn().mockResolvedValue([todo]), create: vi.fn().mockResolvedValue(todo), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}
it('lists tasks from the repository', async () => {
  const { app, repository } = setup();
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(200);
  expect(response.body).toEqual([todo]);
  expect(repository.list).toHaveBeenCalledOnce();
});
it('creates tasks with trimmed input and defaults', async () => {
  const { app, repository } = setup();
  const response = await request(app).post('/api/todos').send({ title: '  Plan the sprint  ', priority: 'high' });
  expect(response.status).toBe(201);
  expect(response.body).toEqual(todo);
  expect(repository.create).toHaveBeenCalledWith({ title: 'Plan the sprint', description: '', priority: 'high', due_date: null, completed: false });
});
it.each([{ title: '  ' }, { title: 'x'.repeat(121) }, { title: 'Task', priority: 'urgent' }, { title: 'Task', due_date: '2026-02-30' }])(
  'rejects invalid create input without calling the repository: %j', async (payload) => {
    const { app, repository } = setup();
    expect((await request(app).post('/api/todos').send(payload)).status).toBe(422);
    expect(repository.create).not.toHaveBeenCalled();
  },
);

it('returns a task by ID and 404 for a missing task', async () => {
  const { app, repository } = setup();
  repository.get.mockResolvedValueOnce(todo).mockResolvedValueOnce(null);
  const found = await request(app).get('/api/todos/1');
  expect(found.status).toBe(200);
  expect(found.body).toEqual(todo);
  expect(repository.get).toHaveBeenCalledWith(1);
  const missing = await request(app).get('/api/todos/2');
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ detail: 'Task not found.' });
});
it.each(['0', '-1', '1.5', 'abc'])('rejects the invalid task ID %s with 422 before touching the repository', async (id) => {
  const { app, repository } = setup();
  for (const call of [request(app).get(`/api/todos/${id}`), request(app).patch(`/api/todos/${id}`).send({ completed: true }), request(app).delete(`/api/todos/${id}`)]) {
    expect((await call).status).toBe(422);
  }
  expect(repository.get).not.toHaveBeenCalled();
  expect(repository.update).not.toHaveBeenCalled();
  expect(repository.delete).not.toHaveBeenCalled();
});
it('updates a task with validated fields', async () => {
  const { app, repository } = setup();
  repository.update.mockResolvedValue({ ...todo, completed: true });
  const response = await request(app).patch('/api/todos/1').send({ completed: true, title: '  Renamed  ' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ...todo, completed: true });
  expect(repository.update).toHaveBeenCalledWith(1, { completed: true, title: 'Renamed' });
});
it.each([{}, { title: '' }, { priority: 'urgent' }, { id: 2 }])('rejects the invalid patch %j with 422', async (payload) => {
  const { app, repository } = setup();
  expect((await request(app).patch('/api/todos/1').send(payload)).status).toBe(422);
  expect(repository.update).not.toHaveBeenCalled();
});
it('returns 404 when updating a missing task', async () => {
  const { app, repository } = setup();
  repository.update.mockResolvedValue(null);
  const response = await request(app).patch('/api/todos/9').send({ completed: true });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Task not found.' });
});
it('deletes a task with 204 and returns 404 when it does not exist', async () => {
  const { app, repository } = setup();
  repository.delete.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const deleted = await request(app).delete('/api/todos/1');
  expect(deleted.status).toBe(204);
  expect(deleted.text).toBe('');
  expect(repository.delete).toHaveBeenCalledWith(1);
  const missing = await request(app).delete('/api/todos/1');
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ detail: 'Task not found.' });
});

afterEach(() => vi.useRealTimers());

it('summarizes the stored tasks against the current date', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T09:00:00Z'));
  const { app, repository } = setup();
  repository.list.mockResolvedValue([
    { ...todo, id: 1, due_date: '2026-10-10' },
    { ...todo, id: 2, due_date: '2026-10-20' },
    { ...todo, id: 3, due_date: null, completed: true },
  ]);
  const response = await request(app).get('/api/todos/stats');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ total: 3, completed: 1, active: 2, overdue: 1 });
  expect(repository.get).not.toHaveBeenCalled();
});
