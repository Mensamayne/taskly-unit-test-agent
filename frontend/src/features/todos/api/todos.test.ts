import { beforeEach, expect, it, vi } from 'vitest'
import { request } from '../../../lib/http'
import { todoFixture } from '../../../test/todoFixture'
import { todosApi } from './todos'

vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

it('passes the abort signal when fetching tasks', async () => {
  const signal = new AbortController().signal
  vi.mocked(request).mockResolvedValue([todoFixture])
  await expect(todosApi.list(signal)).resolves.toEqual([todoFixture])
  expect(request).toHaveBeenCalledWith('/todos', { signal })
})

it('sends only writable task fields on creation', async () => {
  vi.mocked(request).mockResolvedValue(todoFixture)
  await expect(todosApi.create(todoFixture)).resolves.toEqual(todoFixture)
  expect(request).toHaveBeenCalledWith('/todos', {
    method: 'POST',
    body: JSON.stringify({
      title: todoFixture.title,
      description: '',
      priority: 'medium',
      due_date: null,
      completed: false,
    }),
  })
})

it('patches a task with only the writable fields that were given', async () => {
  vi.mocked(request).mockResolvedValue(todoFixture)
  await expect(todosApi.update(7, { completed: true })).resolves.toEqual(
    todoFixture,
  )
  expect(request).toHaveBeenCalledWith('/todos/7', {
    method: 'PATCH',
    body: JSON.stringify({ completed: true }),
  })
})

it('never sends read-only fields when updating from a full task', async () => {
  vi.mocked(request).mockResolvedValue(todoFixture)
  await todosApi.update(todoFixture.id, todoFixture)
  const body = JSON.parse(String(vi.mocked(request).mock.calls[0][1]?.body))
  expect(body).toEqual({
    title: todoFixture.title,
    description: todoFixture.description,
    priority: todoFixture.priority,
    due_date: todoFixture.due_date,
    completed: todoFixture.completed,
  })
})

it('deletes a task by ID', async () => {
  vi.mocked(request).mockResolvedValue(undefined)
  await expect(todosApi.remove(7)).resolves.toBeUndefined()
  expect(request).toHaveBeenCalledWith('/todos/7', { method: 'DELETE' })
})

it('duplicates a task by ID with a POST and no body', async () => {
  const copy = { ...todoFixture, id: 8 }
  vi.mocked(request).mockResolvedValue(copy)
  await expect(todosApi.duplicate(7)).resolves.toEqual(copy)
  expect(request).toHaveBeenCalledWith('/todos/7/duplicate', {
    method: 'POST',
  })
})

it('propagates a failure when duplicating a task', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Not found'))
  await expect(todosApi.duplicate(99)).rejects.toThrow('Not found')
})

it('fetches the task statistics with the abort signal', async () => {
  const signal = new AbortController().signal
  const stats = { total: 2, completed: 1, active: 1, overdue: 0 }
  vi.mocked(request).mockResolvedValue(stats)
  await expect(todosApi.stats(signal)).resolves.toEqual(stats)
  expect(request).toHaveBeenCalledWith('/todos/stats', { signal })
})
