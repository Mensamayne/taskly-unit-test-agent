import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotice } from '../../hooks/useNotice'
import { todoFixture } from '../../test/todoFixture'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import { TodosPage } from './TodosPage'
import type { Todo } from './types'

vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
// Child components are replaced by stand-ins that expose their callbacks as
// buttons, so these tests exercise the page's own wiring.
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: ({ onCreate }: { onCreate: () => void }) => (
    <>
      <h1>Tasks</h1>
      <button onClick={onCreate}>Header: new task</button>
    </>
  ),
}))
vi.mock('./components/TodoFilters', () => ({ TodoFilters: () => null }))
vi.mock('./components/TodoList', () => ({
  TodoList: (props: {
    todos: Todo[]
    onCreate: () => void
    onToggle: (todo: Todo) => void
    onEdit: (todo: Todo) => void
    onDelete: (todo: Todo) => void
  }) => (
    <div>
      <p>Task list</p>
      <button onClick={props.onCreate}>List: new task</button>
      {props.todos.map((todo) => (
        <div key={todo.id}>
          <button onClick={() => props.onToggle(todo)}>
            Toggle {todo.title}
          </button>
          <button onClick={() => props.onEdit(todo)}>Edit {todo.title}</button>
          <button onClick={() => props.onDelete(todo)}>
            Delete {todo.title}
          </button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: (props: {
    todo: Todo | 'new'
    onClose: () => void
    onSaved: (message: string) => void
  }) => (
    <div
      role="dialog"
      aria-label={
        props.todo === 'new' ? 'New task' : `Edit ${props.todo.title}`
      }
    >
      <button onClick={props.onClose}>Close editor</button>
      <button onClick={() => props.onSaved('Changes saved.')}>
        Save editor
      </button>
    </div>
  ),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: (props: {
    todo: Todo
    onClose: () => void
    onDeleted: () => void
  }) => (
    <div role="dialog" aria-label={`Delete ${props.todo.title}`}>
      <button onClick={props.onClose}>Cancel delete</button>
      <button onClick={props.onDeleted}>Confirm delete</button>
    </div>
  ),
}))
vi.mock('../../components/SuccessNotice', () => ({ SuccessNotice: () => null }))

it('displays a query failure and resets mutation errors before retrying', async () => {
  const user = userEvent.setup()
  const refetch = vi.fn().mockResolvedValue(undefined)
  const reset = vi.fn()
  vi.mocked(useTodosQuery).mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    isError: true,
    error: new Error('The server is unavailable.'),
    refetch,
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: null,
    reset,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(false)
  vi.mocked(useNotice).mockReturnValue({ message: '', notify: vi.fn() })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: [],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  render(<TodosPage />)
  expect(screen.getByTestId('alert')).toHaveTextContent(
    'The server is unavailable.',
  )
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
  expect(reset).toHaveBeenCalledTimes(1)
  expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
    refetch.mock.invocationCallOrder[0],
  )
})

describe('TodosPage interactions', () => {
  const notify = vi.fn()
  const mutateAsync = vi.fn()

  function setup({ todos = [todoFixture], busy = false } = {}) {
    vi.mocked(useTodosQuery).mockReturnValue({
      data: todos,
      isPending: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useTodosQuery>)
    vi.mocked(useUpdateTodoMutation).mockReturnValue({
      error: null,
      reset: vi.fn(),
      mutateAsync,
    } as unknown as ReturnType<typeof useUpdateTodoMutation>)
    vi.mocked(useTodosBusy).mockReturnValue(busy)
    vi.mocked(useNotice).mockReturnValue({ message: '', notify })
    vi.mocked(useTodoFilters).mockReturnValue({
      filter: 'all',
      search: '',
      sort: 'newest',
      visible: todos,
      setFilter: vi.fn(),
      setSearch: vi.fn(),
      setSort: vi.fn(),
    })
    render(<TodosPage />)
    return userEvent.setup()
  }

  beforeEach(() => vi.clearAllMocks())

  it('opens the new task editor from the header and the list, and closes it', async () => {
    const user = setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Header: new task' }))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'List: new task' }))
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeVisible()
  })

  it('edits an existing task and closes the editor with a notice after saving', async () => {
    const user = setup()
    await user.click(
      screen.getByRole('button', { name: `Edit ${todoFixture.title}` }),
    )
    expect(
      screen.getByRole('dialog', { name: `Edit ${todoFixture.title}` }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save editor' }))
    expect(notify).toHaveBeenCalledWith('Changes saved.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('completes an active task and confirms it with a notice', async () => {
    mutateAsync.mockResolvedValue({ ...todoFixture, completed: true })
    const user = setup()
    await user.click(
      screen.getByRole('button', { name: `Toggle ${todoFixture.title}` }),
    )
    expect(mutateAsync).toHaveBeenCalledWith({
      id: todoFixture.id,
      input: { completed: true },
    })
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Another task complete. Well done!'),
    )
  })

  it('marks a completed task as active again', async () => {
    const done = { ...todoFixture, completed: true }
    mutateAsync.mockResolvedValue({ ...done, completed: false })
    const user = setup({ todos: [done] })
    await user.click(
      screen.getByRole('button', { name: `Toggle ${done.title}` }),
    )
    expect(mutateAsync).toHaveBeenCalledWith({
      id: done.id,
      input: { completed: false },
    })
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Task marked as active.'),
    )
  })

  it('ignores toggles while another change is in progress', async () => {
    const user = setup({ busy: true })
    await user.click(
      screen.getByRole('button', { name: `Toggle ${todoFixture.title}` }),
    )
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it('does not announce success when toggling fails', async () => {
    mutateAsync.mockRejectedValue(new Error('Server error'))
    const user = setup()
    await user.click(
      screen.getByRole('button', { name: `Toggle ${todoFixture.title}` }),
    )
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(notify).not.toHaveBeenCalled()
  })

  it('confirms deletion with a notice, and cancelling deletes nothing', async () => {
    const user = setup()
    const deleteButton = () =>
      screen.getByRole('button', { name: `Delete ${todoFixture.title}` })
    await user.click(deleteButton())
    await user.click(screen.getByRole('button', { name: 'Cancel delete' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
    await user.click(deleteButton())
    expect(
      screen.getByRole('dialog', { name: `Delete ${todoFixture.title}` }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(notify).toHaveBeenCalledWith('Task deleted.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
