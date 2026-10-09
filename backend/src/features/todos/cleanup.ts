import type { Todo } from './types.js';

/** IDs of completed tasks, oldest first, so a partial failure removes the oldest ones. */
export function completedIds(todos: Todo[]): number[] {
  return todos
    .filter((todo) => todo.completed)
    .sort((a, b) => a.id - b.id)
    .map((todo) => todo.id);
}
