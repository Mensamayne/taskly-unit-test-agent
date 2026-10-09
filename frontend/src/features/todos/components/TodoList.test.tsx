import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('./TodoEmptyState', () => ({
  TodoEmptyState: () => <p>Empty task list</p>,
}))
vi.mock('./TodoItem', () => ({
  TodoItem: (props: {
    todo: Todo
    busy: boolean
    onToggle: () => void
    onEdit: () => void
    onDelete: () => void
  }) => (
    <li>
      {props.todo.title}
      {props.busy && ' (busy)'}
      <button onClick={props.onToggle}>Toggle {props.todo.title}</button>
      <button onClick={props.onEdit}>Edit {props.todo.title}</button>
      <button onClick={props.onDelete}>Delete {props.todo.title}</button>
    </li>
  ),
}))

it('shows loading feedback before showing an empty list', () => {
  const props = {
    todos: [],
    hasTodos: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  }
  const { rerender } = render(<TodoList {...props} loading />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading your tasks…')
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
  rerender(<TodoList {...props} loading={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText('Empty task list')).toBeVisible()
})

function listProps(overrides: Partial<Parameters<typeof TodoList>[0]> = {}) {
  return {
    todos: [] as Todo[],
    hasTodos: false,
    loading: false,
    failed: false,
    busy: false,
    onCreate: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
}

it('renders every task and passes the busy state down', () => {
  const second = { ...todoFixture, id: 8, title: 'Review the plan' }
  render(
    <TodoList
      {...listProps({
        todos: [todoFixture, second],
        hasTodos: true,
        busy: true,
      })}
    />,
  )
  const items = screen.getAllByRole('listitem')
  expect(items).toHaveLength(2)
  expect(items[0]).toHaveTextContent(`${todoFixture.title} (busy)`)
  expect(items[1]).toHaveTextContent(`${second.title} (busy)`)
})

it('calls back with the task the user acted on', async () => {
  const user = userEvent.setup()
  const second = { ...todoFixture, id: 8, title: 'Review the plan' }
  const props = listProps({ todos: [todoFixture, second], hasTodos: true })
  render(<TodoList {...props} />)
  await user.click(
    screen.getByRole('button', { name: `Toggle ${second.title}` }),
  )
  await user.click(screen.getByRole('button', { name: `Edit ${second.title}` }))
  await user.click(
    screen.getByRole('button', { name: `Delete ${todoFixture.title}` }),
  )
  expect(props.onToggle).toHaveBeenCalledWith(second)
  expect(props.onEdit).toHaveBeenCalledWith(second)
  expect(props.onDelete).toHaveBeenCalledWith(todoFixture)
})

it('explains a failed load instead of showing an empty list', () => {
  render(<TodoList {...listProps({ failed: true })} />)
  expect(
    screen.getByRole('heading', {
      name: 'The task list is temporarily unavailable',
    }),
  ).toBeVisible()
  expect(screen.queryByText('Empty task list')).not.toBeInTheDocument()
})

it('keeps showing loaded tasks when a refresh fails', () => {
  render(
    <TodoList
      {...listProps({ todos: [todoFixture], hasTodos: true, failed: true })}
    />,
  )
  expect(screen.getByRole('listitem')).toHaveTextContent(todoFixture.title)
})
