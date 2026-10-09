import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useDuplicateTodoMutation } from './useDuplicateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn(),
  },
}))

const copy = { ...todoFixture, id: 99, title: 'Copy of task' }

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useDuplicateTodoMutation(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useDuplicateTodoMutation', () => {
  it('duplicates the task by id and puts the copy first in the cached list', async () => {
    const other = { ...todoFixture, id: 3, title: 'Older task' }
    vi.mocked(todosApi.duplicate).mockResolvedValue(copy)
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [other])
    await expect(result.current.mutateAsync(7)).resolves.toEqual(copy)
    expect(todosApi.duplicate).toHaveBeenCalledWith(7)
    expect(client.getQueryData(todoKeys.list)).toEqual([copy, other])
  })

  it('starts the list when nothing is cached yet', async () => {
    vi.mocked(todosApi.duplicate).mockResolvedValue(copy)
    const { client, result } = setup()
    await result.current.mutateAsync(7)
    expect(client.getQueryData(todoKeys.list)).toEqual([copy])
  })

  it('refreshes the stats after duplicating', async () => {
    vi.mocked(todosApi.duplicate).mockResolvedValue(copy)
    const { client, result } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await result.current.mutateAsync(7)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: todoKeys.stats })
  })

  it('leaves the cache untouched and exposes the error when duplication fails', async () => {
    vi.mocked(todosApi.duplicate).mockRejectedValue(new Error('Server error'))
    const { client, result } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    client.setQueryData(todoKeys.list, [todoFixture])
    await expect(result.current.mutateAsync(7)).rejects.toThrow('Server error')
    await waitFor(() =>
      expect(result.current.error?.message).toBe('Server error'),
    )
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
    expect(invalidate).not.toHaveBeenCalled()
  })
})
