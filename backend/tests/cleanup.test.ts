import { describe, expect, it } from 'vitest';
import { completedIds } from '../src/features/todos/cleanup.ts';
import { todo } from './fixture.ts';

const make = (id: number, completed: boolean) => ({ ...todo, id, completed });

describe('completedIds', () => {
  it('returns an empty list when there are no tasks', () => {
    expect(completedIds([])).toEqual([]);
  });

  it('returns only the ids of completed tasks', () => {
    expect(completedIds([make(1, false), make(2, true), make(3, false), make(4, true)])).toEqual([2, 4]);
  });

  it('returns an empty list when no task is completed', () => {
    expect(completedIds([make(1, false), make(2, false)])).toEqual([]);
  });

  it('orders ids ascending regardless of input order', () => {
    expect(completedIds([make(10, true), make(2, true), make(7, true)])).toEqual([2, 7, 10]);
  });

  it('does not mutate the input list', () => {
    const input = [make(3, true), make(1, true), make(2, false)];
    completedIds(input);
    expect(input.map((item) => item.id)).toEqual([3, 1, 2]);
  });
});
