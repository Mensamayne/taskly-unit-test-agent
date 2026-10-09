import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useDeleteTodoMutation', () => {
  it('deletes the task and removes only it from the cached list', async () => {
    const other = { ...todoFixture, id: 8, title: 'Keep me' }
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [todoFixture, other])
    await result.current.mutateAsync(todoFixture.id)
    expect(todosApi.remove).toHaveBeenCalledWith(todoFixture.id)
    expect(client.getQueryData(todoKeys.list)).toEqual([other])
  })

  it('does not create a list when nothing is cached', async () => {
    vi.mocked(todosApi.remove).mockResolvedValue(undefined)
    const { client, result } = setup()
    await result.current.mutateAsync(todoFixture.id)
    expect(client.getQueryData(todoKeys.list)).toBeUndefined()
  })

  it('keeps the task in the cache when deletion fails', async () => {
    vi.mocked(todosApi.remove).mockRejectedValue(new Error('Could not delete.'))
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [todoFixture])
    await expect(result.current.mutateAsync(todoFixture.id)).rejects.toThrow(
      'Could not delete.',
    )
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})
