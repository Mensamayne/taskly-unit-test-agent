import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useClearCompletedMutation } from './useClearCompletedMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    stats: vi.fn(),
    clearCompleted: vi.fn(),
  },
}))

const active = { ...todoFixture, id: 1, title: 'Active task', completed: false }
const done = { ...todoFixture, id: 2, title: 'Done task', completed: true }
const alsoDone = { ...todoFixture, id: 3, title: 'Also done', completed: true }

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useClearCompletedMutation(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useClearCompletedMutation', () => {
  it('calls the API and removes completed tasks from the cached list', async () => {
    vi.mocked(todosApi.clearCompleted).mockResolvedValue({ removed: 2 })
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [done, active, alsoDone])
    await expect(result.current.mutateAsync()).resolves.toEqual({ removed: 2 })
    expect(todosApi.clearCompleted).toHaveBeenCalledTimes(1)
    expect(client.getQueryData(todoKeys.list)).toEqual([active])
  })

  it('invalidates the stats query after clearing', async () => {
    vi.mocked(todosApi.clearCompleted).mockResolvedValue({ removed: 1 })
    const { client, result } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(todoKeys.list, [done])
    await result.current.mutateAsync()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: todoKeys.stats })
  })

  it('does not create a list cache when none was loaded', async () => {
    vi.mocked(todosApi.clearCompleted).mockResolvedValue({ removed: 0 })
    const { client, result } = setup()
    await result.current.mutateAsync()
    expect(client.getQueryData(todoKeys.list)).toBeUndefined()
  })

  it('keeps the cached list and exposes the error when clearing fails', async () => {
    vi.mocked(todosApi.clearCompleted).mockRejectedValue(
      new Error('Server error'),
    )
    const { client, result } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(todoKeys.list, [active, done])
    await expect(result.current.mutateAsync()).rejects.toThrow('Server error')
    await waitFor(() =>
      expect(result.current.error?.message).toBe('Server error'),
    )
    expect(client.getQueryData(todoKeys.list)).toEqual([active, done])
    expect(invalidate).not.toHaveBeenCalled()
  })
})
