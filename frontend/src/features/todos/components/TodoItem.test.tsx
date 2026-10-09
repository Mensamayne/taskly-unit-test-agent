import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useDuplicateTodoMutation } from '../hooks/useDuplicateTodoMutation'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useDuplicateTodoMutation')

const mutate = vi.fn()

function mockDuplicate(isPending: boolean) {
  vi.mocked(useDuplicateTodoMutation).mockReturnValue({
    mutate,
    isPending,
  } as unknown as ReturnType<typeof useDuplicateTodoMutation>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDuplicate(false)
})

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
  expect(mutate).not.toHaveBeenCalled()
})

it('duplicates the task by id when the duplicate button is clicked', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={vi.fn()}
      onDelete={onDelete}
    />,
  )
  await user.click(
    screen.getByRole('button', { name: `Duplicate: ${todoFixture.title}` }),
  )
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(mutate).toHaveBeenCalledWith(todoFixture.id)
  expect(onEdit).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})

it('disables the duplicate button while a duplication is pending', () => {
  mockDuplicate(true)
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
  expect(
    screen.getByRole('button', { name: `Duplicate: ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('disables the duplicate button while the item is busy', () => {
  render(
    <TodoItem
      todo={todoFixture}
      busy
      onEdit={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
  expect(
    screen.getByRole('button', { name: `Duplicate: ${todoFixture.title}` }),
  ).toBeDisabled()
})
