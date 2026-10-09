import { CalendarDays, Copy, Pencil, Trash2 } from 'lucide-react'
import { useDuplicateTodoMutation } from '../hooks/useDuplicateTodoMutation'
import type { Todo } from '../types'
import { formatDate, isOverdue, priorityLabels } from '../utils/todos'
import {
  Badge,
  Card,
  Checkbox,
  Heading,
  IconButton,
  Text,
} from '../../../design-system'

export function TodoItem({
  todo,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  todo: Todo
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const duplicate = useDuplicateTodoMutation()
  return (
    <li>
      <Card>
        <div className="todo-row">
          <div className="todo-content stack compact">
            <Heading level={3}>{todo.title}</Heading>
            {todo.description && (
              <Text muted preserveWhitespace>
                {todo.description}
              </Text>
            )}
            <div className="row compact">
              <Text as="span" muted size="small">
                #{todo.id}
              </Text>
              <Badge variant={todo.completed ? 'success' : 'info'}>
                {todo.completed ? 'Completed' : 'To do'}
              </Badge>
              <Text as="span" muted size="small">
                {priorityLabels[todo.priority]}
              </Text>
              {todo.due_date && (
                <Badge variant={isOverdue(todo) ? 'warning' : 'neutral'}>
                  <span className="row compact">
                    <CalendarDays size={14} aria-hidden="true" />
                    {formatDate(todo.due_date)}
                    {isOverdue(todo) && ' · overdue'}
                  </span>
                </Badge>
              )}
            </div>
          </div>
          <div className="row compact todo-actions">
            <Checkbox
              label=""
              checked={todo.completed}
              disabled={busy}
              onChange={onToggle}
              aria-label={`${todo.completed ? 'Mark as active' : 'Complete'}: ${todo.title}`}
            />
            <IconButton
              variant="ghost"
              disabled={busy}
              onClick={onEdit}
              aria-label={`Edit: ${todo.title}`}
            >
              <Pencil size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              variant="ghost"
              disabled={busy || duplicate.isPending}
              onClick={() => duplicate.mutate(todo.id)}
              aria-label={`Duplicate: ${todo.title}`}
            >
              <Copy size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              variant="ghost"
              disabled={busy}
              onClick={onDelete}
              aria-label={`Delete: ${todo.title}`}
            >
              <Trash2 size={16} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </Card>
    </li>
  )
}
