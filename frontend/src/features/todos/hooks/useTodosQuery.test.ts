import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useTodosQuery } from './useTodosQuery'

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
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useTodosQuery(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useTodosQuery', () => {
  it('loads the task list with a cancellable request and caches it', async () => {
    vi.mocked(todosApi.list).mockResolvedValue([todoFixture])
    const { client, result } = setup()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([todoFixture])
    expect(todosApi.list).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(client.getQueryData(todoKeys.list)).toEqual([todoFixture])
  })

  it('exposes a failed load as an error', async () => {
    vi.mocked(todosApi.list).mockRejectedValue(new Error('Cannot connect'))
    const { result } = setup()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Cannot connect')
  })
})
