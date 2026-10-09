import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNotice } from './useNotice'

afterEach(() => vi.useRealTimers())

it('starts without a notice and exposes a notification callback', () => {
  const { result } = renderHook(() => useNotice())
  expect(result.current.message).toBe('')
  expect(result.current.notify).toEqual(expect.any(Function))
})

it('shows a notice and clears it after four seconds', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useNotice())
  act(() => result.current.notify('Task deleted.'))
  expect(result.current.message).toBe('Task deleted.')
  act(() => vi.advanceTimersByTime(3999))
  expect(result.current.message).toBe('Task deleted.')
  act(() => vi.advanceTimersByTime(1))
  expect(result.current.message).toBe('')
})

it('gives a repeated notice its own full display time', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useNotice())
  act(() => result.current.notify('Changes saved.'))
  act(() => vi.advanceTimersByTime(3000))
  act(() => result.current.notify('Changes saved.'))
  act(() => vi.advanceTimersByTime(3000))
  expect(result.current.message).toBe('Changes saved.')
  act(() => vi.advanceTimersByTime(1000))
  expect(result.current.message).toBe('')
})

it('keeps the notification callback stable across renders', () => {
  const { result, rerender } = renderHook(() => useNotice())
  const first = result.current.notify
  rerender()
  expect(result.current.notify).toBe(first)
})

it('cancels the pending timer when unmounted', () => {
  vi.useFakeTimers()
  const { result, unmount } = renderHook(() => useNotice())
  act(() => result.current.notify('Task deleted.'))
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
