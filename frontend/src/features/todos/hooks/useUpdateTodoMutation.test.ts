import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

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
  const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useUpdateTodoMutation', () => {
  it('sends the change and replaces only the saved task in the cached list', async () => {
    const other = { ...todoFixture, id: 8, title: 'Untouched' }
    const saved = { ...todoFixture, completed: true }
    vi.mocked(todosApi.update).mockResolvedValue(saved)
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [todoFixture, other])
    await expect(
      result.current.mutateAsync({
        id: todoFixture.id,
        input: { completed: true },
      }),
    ).resolves.toEqual(saved)
    expect(todosApi.update).toHaveBeenCalledWith(todoFixture.id, {
      completed: true,
    })
    expect(client.getQueryData(todoKeys.list)).toEqual([saved, other])
  })

  it('does not create a list when nothing is cached', async () => {
    vi.mocked(todosApi.update).mockResolvedValue(todoFixture)
    const { client, result } = setup()
    await result.current.mutateAsync({
      id: todoFixture.id,
      input: { title: 'x' },
    })
    expect(client.getQueryData(todoKeys.list)).toBeUndefined()
  })

  it('keeps the cached task unchanged when the update fails', async () => {
    vi.mocked(todosApi.update).mockRejectedValue(new Error('Server error'))
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [todoFixture])
    await expect(
      result.current.mutateAsync({
        id: todoFixture.id,
        input: { completed: true },
      }),
    ).rejects.toThrow('Server error')
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})
