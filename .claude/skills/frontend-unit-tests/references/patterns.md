# Frontend test patterns

## Component with design-system mocks

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { TodoEmptyState } from './TodoEmptyState'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('offers to create the first task when there are none', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  render(<TodoEmptyState hasTodos={false} disabled={false} onCreate={onCreate} />)
  await user.click(screen.getByRole('button', { name: 'Add your first task' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
})
```

The relative path in `vi.mock` must match the import path used by the component's directory depth.

## Mutation hook with a real QueryClient

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todosApi } from '../api/todos'
import { todoKeys } from '../api/queryKeys'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'

vi.mock('../api/todos', () => ({
  todosApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
beforeEach(() => vi.clearAllMocks())

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

it('removes the deleted task from the cached list', async () => {
  const { client, wrapper } = setup()
  client.setQueryData(todoKeys.list, [todoFixture, { ...todoFixture, id: 8 }])
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
  await result.current.mutateAsync(todoFixture.id)
  await waitFor(() =>
    expect(client.getQueryData(todoKeys.list)).toEqual([{ ...todoFixture, id: 8 }]),
  )
})
```

## fetch for `lib/http.ts`

```ts
import { afterEach, expect, it, vi } from 'vitest'
import { request } from './http'

afterEach(() => vi.unstubAllGlobals())

it('uses the server detail message for failed requests', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Task not found.' }), { status: 404 }),
    ),
  )
  await expect(request('/todos/1')).rejects.toThrow('Task not found.')
})
```

`new Response(null, { status: 204 })` covers the empty-body branch. A rejected `fetch` with an aborted signal must rethrow the original error.

## Timers and dates

```ts
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNotice } from './useNotice'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('clears the notice after four seconds', () => {
  const { result } = renderHook(() => useNotice())
  act(() => result.current.notify('Saved.'))
  expect(result.current.message).toBe('Saved.')
  act(() => vi.advanceTimersByTime(4000))
  expect(result.current.message).toBe('')
})
```

For `isOverdue`, set `vi.setSystemTime(new Date('2026-10-15T12:00:00'))` and compare against due dates before and after that day.

## Page-level components

`TodosPage.test.tsx` shows the pattern: mock every hook and child component by module path, return typed objects from the hooks, and assert on what the page renders and which callbacks it calls.
