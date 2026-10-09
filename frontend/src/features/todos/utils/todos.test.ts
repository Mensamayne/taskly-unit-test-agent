import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatDate,
  isDueToday,
  isOverdue,
  selectTodos,
  validateTodo,
} from './todos'
import type { Todo, TodoInput } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })

  it('keeps only completed tasks for the completed filter', () => {
    const done = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('sorts by due date with undated tasks last and newer tasks first on ties', () => {
    const soon = { ...base, id: 2, due_date: '2026-10-10' }
    const later = { ...base, id: 3, due_date: '2026-11-01' }
    const laterNewer = { ...base, id: 4, due_date: '2026-11-01' }
    const undated = { ...base, id: 5 }
    expect(
      selectTodos([undated, later, laterNewer, soon], 'all', '', 'due'),
    ).toEqual([soon, laterNewer, later, undated])
  })

  it('sorts newest first by creation time, then by id', () => {
    const older = { ...base, id: 2, created_at: '2026-09-01T12:00:00Z' }
    const sameTimeHigherId = { ...base, id: 3 }
    expect(
      selectTodos([older, base, sameTimeHigherId], 'all', '', 'newest'),
    ).toEqual([sameTimeHigherId, base, older])
  })
})

describe('validateTodo', () => {
  const valid: TodoInput = {
    title: 'Prepare a demo',
    description: '',
    priority: 'medium',
    due_date: null,
    completed: false,
  }

  it('accepts a valid task, including boundary lengths and a leap day', () => {
    expect(validateTodo(valid)).toEqual({})
    expect(
      validateTodo({
        ...valid,
        title: ` ${'x'.repeat(120)} `,
        description: 'x'.repeat(2000),
        due_date: '2024-02-29',
      }),
    ).toEqual({})
  })

  it.each(['', '   '])('asks for a title when it is %j', (title) => {
    expect(validateTodo({ ...valid, title })).toEqual({
      title: 'Enter a task title.',
    })
  })

  it('limits the title to 120 characters', () => {
    expect(validateTodo({ ...valid, title: 'x'.repeat(121) })).toEqual({
      title: 'The title must be at most 120 characters.',
    })
  })

  it('limits the description to 2000 characters', () => {
    expect(validateTodo({ ...valid, description: 'x'.repeat(2001) })).toEqual({
      description: 'The description must be at most 2000 characters.',
    })
  })

  it.each(['2026-02-30', '2025-02-29', '2026-2-3', '15/10/2026', 'tomorrow'])(
    'rejects the due date %s',
    (due_date) => {
      expect(validateTodo({ ...valid, due_date })).toEqual({
        due_date: 'Enter a valid date.',
      })
    },
  )

  it('reports every invalid field at once', () => {
    expect(
      validateTodo({
        ...valid,
        title: '',
        description: 'x'.repeat(2001),
        due_date: '2026-13-01',
      }),
    ).toEqual({
      title: 'Enter a task title.',
      description: 'The description must be at most 2000 characters.',
      due_date: 'Enter a valid date.',
    })
  })
})

describe('isOverdue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('flags an active task whose due date has passed', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-14' })).toBe(true)
  })

  it('does not flag tasks due today or later', () => {
    expect(isOverdue({ ...base, due_date: '2026-10-15' })).toBe(false)
    expect(isOverdue({ ...base, due_date: '2026-10-16' })).toBe(false)
  })

  it('never flags completed or undated tasks', () => {
    expect(
      isOverdue({ ...base, completed: true, due_date: '2026-10-01' }),
    ).toBe(false)
    expect(isOverdue({ ...base, due_date: null })).toBe(false)
  })
})

describe('isDueToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('flags an active task due on the local calendar day', () => {
    expect(isDueToday({ ...base, due_date: '2026-10-15' })).toBe(true)
  })

  it('does not flag tasks due on other days', () => {
    expect(isDueToday({ ...base, due_date: '2026-10-14' })).toBe(false)
    expect(isDueToday({ ...base, due_date: '2026-10-16' })).toBe(false)
  })

  it('never flags completed or undated tasks', () => {
    expect(
      isDueToday({ ...base, completed: true, due_date: '2026-10-15' }),
    ).toBe(false)
    expect(isDueToday({ ...base, due_date: null })).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats calendar dates in British English', () => {
    expect(formatDate('2026-10-15')).toBe('15 Oct 2026')
    expect(formatDate('2024-02-29')).toBe('29 Feb 2024')
  })
})

describe('selectTodos by title', () => {
  it('sorts alphabetically regardless of case, newer tasks first on equal titles', () => {
    const apples = { ...base, id: 2, title: 'apples' }
    const bread = { ...base, id: 3, title: 'Bread' }
    const applesNewer = { ...base, id: 4, title: 'Apples' }
    expect(
      selectTodos([bread, apples, applesNewer], 'all', '', 'title'),
    ).toEqual([applesNewer, apples, bread])
  })
})
