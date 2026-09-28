import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { getTaskListSnapshot } from '@renderer/hooks/use-task-list'
import { transport } from '@renderer/lib/transport'
import { type CommandId, CommandIds } from '@shared/commands-catalog'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { rendererTaskMenuRequestSchema } from '@shared/schemas/application-menu'
import {
  type BulkTaskCommandResult,
  isStoppedTaskStatus,
} from '@shared/types/task-actions'
import { useEffect, useState } from 'react'
import {
  MenuConfirmation,
  type MenuConfirmationRequest,
} from './menu-confirmation'
import {
  captureTaskMenuIntent,
  startMenuConnection,
  type TaskMenuIntent,
  taskWritesAvailable,
} from './task-context'
import { useMenuCommand } from './use-menu-command'

export function DesktopMenuActions() {
  const [pending, setPending] = useState<{
    intent: TaskMenuIntent
    id: CommandId
  } | null>(null)
  const [confirmation, setConfirmation] =
    useState<MenuConfirmationRequest | null>(null)
  useEffect(startMenuConnection, [])
  const confirmClear = () => {
    const ids = getTaskListSnapshot()
      .tasks.filter((task) => isStoppedTaskStatus(task.status))
      .map((task) => task.id)
    if (!ids.length) return
    setConfirmation({
      kind: 'clear',
      count: ids.length,
      run: async () => {
        if (!taskWritesAvailable()) throw new Error('Task snapshot unavailable')
        const result = (await transport.invoke(
          Commands.ClearStoppedTasks,
          ids
        )) as BulkTaskCommandResult
        if (result.failed.length) throw new Error('Some records were retained')
      },
    })
  }
  const execute = useMenuCommand(pending?.intent, confirmClear)
  useIpcEvent(Events.RendererTaskMenuRequested, (...args) => {
    const parsed = rendererTaskMenuRequestSchema.safeParse(args[0])
    if (!parsed.success || document.querySelector('[role="dialog"]')) return
    const intent = captureTaskMenuIntent()
    const request = parsed.data
    if (
      request.commandId !== CommandIds.TaskClearStopped &&
      (request.generation !== intent.generation ||
        JSON.stringify(request.taskIds) !== JSON.stringify(intent.ids))
    )
      return
    setPending({ intent, id: request.commandId })
  })
  useEffect(() => {
    if (!pending) return
    setPending(null)
    void execute(pending.id)
  }, [pending, execute])
  return (
    <MenuConfirmation
      request={confirmation}
      close={() => setConfirmation(null)}
    />
  )
}
