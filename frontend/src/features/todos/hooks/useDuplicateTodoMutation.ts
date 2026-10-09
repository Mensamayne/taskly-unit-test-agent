import { useMutation, useQueryClient } from '@tanstack/react-query'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo } from '../types'

export function useDuplicateTodoMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: todoKeys.duplicate,
    mutationFn: (id: number) => todosApi.duplicate(id),
    onSuccess: async (copy) => {
      await queryClient.cancelQueries({ queryKey: todoKeys.list })
      queryClient.setQueryData<Todo[]>(todoKeys.list, (current = []) => [
        copy,
        ...current,
      ])
      await queryClient.invalidateQueries({ queryKey: todoKeys.stats })
    },
  })
}
