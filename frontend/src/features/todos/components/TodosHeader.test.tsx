import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { TodosHeader } from './TodosHeader'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('invokes creation when enabled and blocks it when disabled', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  const onClearCompleted = vi.fn()
  const { rerender } = render(
    <TodosHeader
      disabled={false}
      completedCount={0}
      onCreate={onCreate}
      onClearCompleted={onClearCompleted}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  expect(
    screen.getByText('Create, organize, and complete tasks.'),
  ).toBeVisible()
  const button = screen.getByRole('button', { name: 'New task' })
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
  rerender(
    <TodosHeader
      disabled
      completedCount={0}
      onCreate={onCreate}
      onClearCompleted={onClearCompleted}
    />,
  )
  expect(button).toBeDisabled()
  await user.click(button)
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('shows the completed count and clears completed tasks when there are some', async () => {
  const user = userEvent.setup()
  const onClearCompleted = vi.fn()
  render(
    <TodosHeader
      disabled={false}
      completedCount={3}
      onCreate={vi.fn()}
      onClearCompleted={onClearCompleted}
    />,
  )
  const clear = screen.getByRole('button', { name: 'Clear completed (3)' })
  expect(clear).toBeEnabled()
  await user.click(clear)
  expect(onClearCompleted).toHaveBeenCalledTimes(1)
})

it('disables clearing completed tasks when none are completed', async () => {
  const user = userEvent.setup()
  const onClearCompleted = vi.fn()
  render(
    <TodosHeader
      disabled={false}
      completedCount={0}
      onCreate={vi.fn()}
      onClearCompleted={onClearCompleted}
    />,
  )
  const clear = screen.getByRole('button', { name: 'Clear completed (0)' })
  expect(clear).toBeDisabled()
  await user.click(clear)
  expect(onClearCompleted).not.toHaveBeenCalled()
})

it('disables clearing completed tasks when the header is disabled', async () => {
  const user = userEvent.setup()
  const onClearCompleted = vi.fn()
  render(
    <TodosHeader
      disabled
      completedCount={2}
      onCreate={vi.fn()}
      onClearCompleted={onClearCompleted}
    />,
  )
  const clear = screen.getByRole('button', { name: 'Clear completed (2)' })
  expect(clear).toBeDisabled()
  await user.click(clear)
  expect(onClearCompleted).not.toHaveBeenCalled()
})
