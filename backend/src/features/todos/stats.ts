import { isDueToday, isOverdue } from './dueLabel.js';
import type { Todo } from './types.js';

export interface TodoStats {
  total: number;
  completed: number;
  active: number;
  /** Active tasks whose due date is before `today`. Completed tasks are never overdue. */
  overdue: number;
  /** Active tasks due exactly on `today`. */
  dueToday: number;
}

/**
 * Summary counts for the task list.
 * @param today calendar date (YYYY-MM-DD) the overdue check compares against
 */
export function computeStats(todos: Todo[], today: string): TodoStats {
  const completed = todos.filter((todo) => todo.completed).length;
  return {
    total: todos.length,
    completed,
    active: todos.length - completed,
    overdue: todos.filter((todo) => isOverdue(todo.due_date, today, todo.completed)).length,
    dueToday: todos.filter((todo) => !todo.completed && isDueToday(todo.due_date, today)).length,
  };
}
