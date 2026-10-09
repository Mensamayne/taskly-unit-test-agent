import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { useTodoFilters } from './useTodoFilters'

const active: Todo = { ...todoFixture, id: 1, title: 'Write the report' }
const done: Todo = {
  ...todoFixture,
  id: 2,
  title: 'Book the room',
  completed: true,
  priority: 'high',
}

describe('useTodoFilters', () => {
  it('starts with all tasks, no search, and newest first', () => {
    const { result } = renderHook(() => useTodoFilters([active, done]))
    expect(result.current.filter).toBe('all')
    expect(result.current.search).toBe('')
    expect(result.current.sort).toBe('newest')
    expect(result.current.visible).toEqual([done, active])
  })

  it('narrows the visible tasks by status and search', () => {
    const { result } = renderHook(() => useTodoFilters([active, done]))
    act(() => result.current.setFilter('completed'))
    expect(result.current.filter).toBe('completed')
    expect(result.current.visible).toEqual([done])
    act(() => {
      result.current.setFilter('all')
      result.current.setSearch('report')
    })
    expect(result.current.search).toBe('report')
    expect(result.current.visible).toEqual([active])
  })

  it('re-sorts the visible tasks when the sort changes', () => {
    const low: Todo = { ...active, id: 3, priority: 'low' }
    const { result } = renderHook(() => useTodoFilters([low, done]))
    act(() => result.current.setSort('priority'))
    expect(result.current.sort).toBe('priority')
    expect(result.current.visible).toEqual([done, low])
  })

  it('follows new task data from the caller', () => {
    const { result, rerender } = renderHook(
      ({ todos }) => useTodoFilters(todos),
      { initialProps: { todos: [active] } },
    )
    rerender({ todos: [active, done] })
    expect(result.current.visible).toEqual([done, active])
  })
})
