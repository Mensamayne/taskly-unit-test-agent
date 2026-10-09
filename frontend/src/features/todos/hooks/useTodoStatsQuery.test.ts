import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import { useTodoStatsQuery } from './useTodoStatsQuery'

vi.mock('../api/todos', () => ({
  todosApi: { stats: vi.fn() },
}))

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useTodoStatsQuery(), { wrapper })
  return { client, result }
}

beforeEach(() => vi.clearAllMocks())

describe('useTodoStatsQuery', () => {
  it('loads the statistics with a cancellable request under the stats key', async () => {
    const stats = { total: 3, completed: 1, active: 2, overdue: 1 }
    vi.mocked(todosApi.stats).mockResolvedValue(stats)
    const { client, result } = setup()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(stats)
    expect(todosApi.stats).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(client.getQueryData(todoKeys.stats)).toEqual(stats)
  })

  it('reports a failed load', async () => {
    vi.mocked(todosApi.stats).mockRejectedValue(new Error('Server error'))
    const { result } = setup()
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
