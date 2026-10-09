import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTodoStatsQuery } from '../hooks/useTodoStatsQuery'
import type { TodoStats as Stats } from '../types'
import { TodoStats } from './TodoStats'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useTodoStatsQuery', () => ({ useTodoStatsQuery: vi.fn() }))

function mockStats(state: { data?: Stats; isError?: boolean }) {
  vi.mocked(useTodoStatsQuery).mockReturnValue({
    data: state.data,
    isError: state.isError ?? false,
  } as unknown as ReturnType<typeof useTodoStatsQuery>)
}

beforeEach(() => vi.clearAllMocks())

describe('TodoStats', () => {
  it('shows a placeholder while the counts load', () => {
    mockStats({})
    render(<TodoStats />)
    expect(screen.getByText('Counting your tasks…')).toBeVisible()
  })

  it('renders nothing when the counts cannot be loaded', () => {
    mockStats({ isError: true })
    const { container } = render(<TodoStats />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there are no tasks', () => {
    mockStats({ data: { total: 0, completed: 0, active: 0, overdue: 0 } })
    const { container } = render(<TodoStats />)
    expect(container).toBeEmptyDOMElement()
  })

  it('summarizes the tasks and highlights overdue ones', () => {
    mockStats({ data: { total: 5, completed: 2, active: 3, overdue: 1 } })
    render(<TodoStats />)
    const summary = screen.getByRole('region', { name: 'Task summary' })
    expect(summary).toHaveTextContent('5 tasks')
    expect(summary).toHaveTextContent('3 to do')
    expect(summary).toHaveTextContent('2 completed')
    expect(summary).toHaveTextContent('1 overdue')
  })

  it('uses the singular for one task and hides the overdue badge when none are late', () => {
    mockStats({ data: { total: 1, completed: 0, active: 1, overdue: 0 } })
    render(<TodoStats />)
    const summary = screen.getByRole('region', { name: 'Task summary' })
    expect(summary).toHaveTextContent('1 task')
    expect(summary).not.toHaveTextContent('1 tasks')
    expect(summary).not.toHaveTextContent('overdue')
  })
})
