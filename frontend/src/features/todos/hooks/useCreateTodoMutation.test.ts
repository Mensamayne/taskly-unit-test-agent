import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { TodoInput } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}))

const input: TodoInput = {
  title: 'Prepare a demo',
  description: '',
  priority: 'medium',
  due_date: null,
  completed: false,
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useCreateTodoMutation', () => {
  it('creates the task and puts it first in the cached list', async () => {
    const other = { ...todoFixture, id: 3, title: 'Older task' }
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [other])
    await expect(result.current.mutateAsync(input)).resolves.toEqual(
      todoFixture,
    )
    expect(todosApi.create).toHaveBeenCalledWith(input)
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
  })

  it('does not duplicate a task that is already in the cache', async () => {
    const stale = { ...todoFixture, title: 'Stale copy' }
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [stale])
    await result.current.mutateAsync(input)
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })

  it('starts the list when nothing is cached yet', async () => {
    vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
    const { client, result } = setup()
    await result.current.mutateAsync(input)
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })

  it('leaves the cache untouched and exposes the error when creation fails', async () => {
    vi.mocked(todosApi.create).mockRejectedValue(new Error('Server error'))
    const { client, result } = setup()
    client.setQueryData(todoKeys.list, [todoFixture])
    await expect(result.current.mutateAsync(input)).rejects.toThrow(
      'Server error',
    )
    await waitFor(() =>
      expect(result.current.error?.message).toBe('Server error'),
    )
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })
})
