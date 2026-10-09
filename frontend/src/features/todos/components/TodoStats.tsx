import { Badge, Text } from '../../../design-system'
import { useTodoStatsQuery } from '../hooks/useTodoStatsQuery'

export function TodoStats() {
  const { data, isError } = useTodoStatsQuery()
  if (isError) return null
  if (!data) return <Text muted>Counting your tasks…</Text>
  if (!data.total) return null
  return (
    <section className="row compact" aria-label="Task summary">
      <Text as="span">
        {data.total} {data.total === 1 ? 'task' : 'tasks'}
      </Text>
      <Badge variant="info">{data.active} to do</Badge>
      <Badge variant="success">{data.completed} completed</Badge>
      {data.overdue > 0 && (
        <Badge variant="warning">{data.overdue} overdue</Badge>
      )}
    </section>
  )
}
