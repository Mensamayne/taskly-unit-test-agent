import { describe, expect, it } from 'vitest';
import { isDueToday, isOverdue } from '../src/features/todos/dueLabel.ts';

const today = '2026-10-15';

describe('isDueToday', () => {
  it('is false when there is no due date', () => {
    expect(isDueToday(null, today)).toBe(false);
  });

  it('is true only when the due date matches today', () => {
    expect(isDueToday(today, today)).toBe(true);
    expect(isDueToday('2026-10-14', today)).toBe(false);
  });
});

describe('isOverdue', () => {
  it('never treats completed tasks as overdue', () => {
    expect(isOverdue('2026-10-01', today, true)).toBe(false);
  });

  it('is false when there is no due date', () => {
    expect(isOverdue(null, today, false)).toBe(false);
  });

  it('is true only for active tasks due before today', () => {
    expect(isOverdue('2026-10-14', today, false)).toBe(true);
    expect(isOverdue(today, today, false)).toBe(false);
    expect(isOverdue('2026-10-16', today, false)).toBe(false);
  });
});
