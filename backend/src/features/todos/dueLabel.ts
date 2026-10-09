/**
 * Calendar-day helpers for task due dates (YYYY-MM-DD).
 */

/** True when an active task is due on `today`. */
export function isDueToday(dueDate: string | null, today: string): boolean {
  return dueDate !== null && dueDate === today;
}

/** True when an active task is overdue relative to `today`. */
export function isOverdue(dueDate: string | null, today: string, completed: boolean): boolean {
  if (completed || dueDate === null) return false;
  return dueDate < today;
}
