import type { Todo, TodoCreate } from './types.js';

const TITLE_LIMIT = 120;
const SUFFIX = ' (copy)';

/**
 * Input for a new task that copies an existing one. The copy starts active, and its title gets
 * a " (copy)" suffix; the original title is shortened when needed so the result fits 120 characters.
 */
export function duplicateInput(todo: Todo): TodoCreate {
  const base = todo.title.slice(0, TITLE_LIMIT - SUFFIX.length).trimEnd();
  return {
    title: `${base}${SUFFIX}`,
    description: todo.description,
    priority: todo.priority,
    due_date: todo.due_date,
    completed: false,
  };
}
