import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from './http'

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function failFetch(error: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => vi.unstubAllGlobals())

describe('request', () => {
  it('calls the API under /api with JSON headers and returns the parsed body', async () => {
    const fetchMock = stubFetch(json([{ id: 1 }]))
    await expect(
      request('/todos', { method: 'POST', headers: { 'X-Trace': 'abc' } }),
    ).resolves.toEqual([{ id: 1 }])
    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
    })
  })

  it('resolves to undefined for 204 No Content', async () => {
    stubFetch(new Response(null, { status: 204 }))
    await expect(
      request('/todos/1', { method: 'DELETE' }),
    ).resolves.toBeUndefined()
  })

  it('reports an unreachable server with a friendly message', async () => {
    failFetch(new TypeError('Failed to fetch'))
    await expect(request('/todos')).rejects.toThrow(
      'Cannot connect to the server. Please try again.',
    )
  })

  it('rethrows the original error when the request was aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = new DOMException(
      'The operation was aborted.',
      'AbortError',
    )
    failFetch(abortError)
    await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
      abortError,
    )
  })

  it('explains the task field limits on 422 responses', async () => {
    stubFetch(json({ detail: [{ msg: 'too long' }] }, 422))
    await expect(request('/todos')).rejects.toThrow(
      'Check the task details: title up to 120 characters, description up to 2000 characters, and a valid due date.',
    )
  })

  it('shows the server detail message for other failures', async () => {
    stubFetch(json({ detail: 'Task not found.' }, 404))
    await expect(request('/todos/9')).rejects.toThrow('Task not found.')
  })

  it.each([
    ['a non-string detail', json({ detail: { code: 'x' } }, 500)],
    [
      'a body that is not JSON',
      new Response('<html>Bad gateway</html>', { status: 502 }),
    ],
  ])('falls back to a generic message for %s', async (_case, response) => {
    stubFetch(response)
    await expect(request('/todos')).rejects.toThrow(
      'The operation failed. Please try again.',
    )
  })
})
