import { describe, expect, it } from 'vitest';
import { duplicateInput } from '../src/features/todos/duplicate.ts';
import { todo } from './fixture.ts';

describe('duplicateInput', () => {
  it('appends a " (copy)" suffix and keeps description, priority and due date', () => {
    expect(duplicateInput(todo)).toEqual({
      title: 'Plan the sprint (copy)',
      description: todo.description,
      priority: 'high',
      due_date: '2026-10-15',
      completed: false,
    });
  });

  it('starts the copy as active even when the original is completed', () => {
    expect(duplicateInput({ ...todo, completed: true }).completed).toBe(false);
  });

  it('keeps a null due date', () => {
    expect(duplicateInput({ ...todo, due_date: null }).due_date).toBeNull();
  });

  it('does not shorten a title that still fits with the suffix in 120 characters', () => {
    const title = 'a'.repeat(113);
    const result = duplicateInput({ ...todo, title });
    expect(result.title).toBe(`${title} (copy)`);
    expect(result.title).toHaveLength(120);
  });

  it('shortens a long title so the result is at most 120 characters and ends with the suffix', () => {
    const result = duplicateInput({ ...todo, title: 'a'.repeat(120) });
    expect(result.title).toBe(`${'a'.repeat(113)} (copy)`);
    expect(result.title).toHaveLength(120);
  });

  it('does not leave whitespace before the suffix when shortening cuts after a space', () => {
    const title = `${'a'.repeat(112)} ${'b'.repeat(20)}`;
    expect(duplicateInput({ ...todo, title }).title).toBe(`${'a'.repeat(112)} (copy)`);
  });
});
