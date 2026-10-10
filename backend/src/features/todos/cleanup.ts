import type { Todo } from './types.js';

/** IDs of completed tasks in ascending order. */
export function completedIds(todos: Todo[]): number[] {
  return todos
    .filter((todo) => todo.completed)
    .sort((a, b) => a.id - b.id)
    .map((todo) => todo.id);
}
