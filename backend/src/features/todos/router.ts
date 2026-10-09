import { Router } from 'express';
import type { TodoStore } from './types.js';
import { createSchema, updateSchema, idSchema } from './validators.js';
import { computeStats } from './stats.js';

export function createTodosRouter(repository: TodoStore) {
  const router = Router();
  router.param('id', (req, res, next, id) => {
    const result = idSchema.safeParse(id);
    if (!result.success) return res.status(422).json({ detail: result.error.issues });
    res.locals.todoId = result.data;
    next();
  });
  router.get('/', async (req, res) => res.json(await repository.list()));
  router.get('/stats', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    res.json(computeStats(await repository.list(), today));
  });
  router.post('/', async (req, res) => {
    const result = createSchema.safeParse(req.body);
    if (!result.success) return res.status(422).json({ detail: result.error.issues });
    res.status(201).json(await repository.create(result.data));
  });
  router.get('/:id', async (req, res) => {
    const todo = await repository.get(Number(res.locals.todoId));
    if (!todo) return res.status(404).json({ detail: 'Task not found.' });
    res.json(todo);
  });
  router.patch('/:id', async (req, res) => {
    const result = updateSchema.safeParse(req.body);
    if (!result.success) return res.status(422).json({ detail: result.error.issues });
    const todo = await repository.update(Number(res.locals.todoId), result.data);
    if (!todo) return res.status(404).json({ detail: 'Task not found.' });
    res.json(todo);
  });
  router.delete('/:id', async (req, res) => {
    if (!await repository.delete(Number(res.locals.todoId))) return res.status(404).json({ detail: 'Task not found.' });
    res.status(204).end();
  });
  return router;
}
