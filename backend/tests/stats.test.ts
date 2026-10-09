import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/features/todos/stats.ts';
import type { Todo } from '../src/features/todos/types.ts';
import { todo } from './fixture.ts';

const today = '2026-10-15';
const task = (overrides: Partial<Todo>): Todo => ({ ...todo, ...overrides });

describe('computeStats', () => {
  it('returns zero counts for an empty list', () => {
    expect(computeStats([], today)).toEqual({ total: 0, completed: 0, active: 0, overdue: 0 });
  });

  it('splits tasks into completed and active', () => {
    const todos = [task({ id: 1, completed: true }), task({ id: 2 }), task({ id: 3 })];
    expect(computeStats(todos, today)).toMatchObject({ total: 3, completed: 1, active: 2 });
  });

  it('counts active tasks due before today as overdue', () => {
    const todos = [
      task({ id: 1, due_date: '2026-10-14' }),
      task({ id: 2, due_date: '2026-10-15' }),
      task({ id: 3, due_date: '2026-10-16' }),
      task({ id: 4, due_date: null }),
    ];
    expect(computeStats(todos, today).overdue).toBe(1);
  });

  it('never counts completed tasks as overdue', () => {
    const todos = [task({ id: 1, due_date: '2026-10-01', completed: true }), task({ id: 2, due_date: '2026-10-01' })];
    expect(computeStats(todos, today)).toEqual({ total: 2, completed: 1, active: 1, overdue: 1 });
  });
});
