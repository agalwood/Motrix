import { toast } from '@renderer/components/ui/toast'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { transport } from '@renderer/lib/transport'
import { useTaskActions } from '@renderer/routes/downloads/inspector/use-task-actions'
import { type CommandId, CommandIds } from '@shared/commands-catalog'
import { Commands } from '@shared/protocol/commands'
import type { BulkTaskCommandResult } from '@shared/types/task-actions'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { requestMenuNavigationFocus } from './navigation-focus'
import {
  focusDownloadsList,
  menuActionEnabled,
  selectAllDownloads,
  selectedMenuTasks,
  type TaskMenuIntent,
} from './task-context'

export function useMenuCommand(
  intent: TaskMenuIntent | undefined,
  confirmClear: () => void
) {
  const actions = useTaskActions(selectedMenuTasks(intent))
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  return async (id: CommandId) => {
    if (!menuActionEnabled(id, intent)) return
    try {
      switch (id) {
        case CommandIds.AppShowAbout:
          requestMenuNavigationFocus('/settings/about')
          navigate('/settings/about')
          return
        case CommandIds.AppOpenPreferences:
          requestMenuNavigationFocus('/settings')
          navigate('/settings')
          return
        case CommandIds.TaskNew:
          await openAddTaskDialog({ tab: 'links' })
          return
        case CommandIds.TaskNewBt:
          await openAddTaskDialog({ tab: 'torrent' })
          return
        case CommandIds.NavigateTaskList:
          if (!location.pathname.startsWith('/downloads')) {
            requestMenuNavigationFocus('/downloads/all')
            navigate('/downloads/all')
          } else focusDownloadsList()
          return
        case CommandIds.TaskSelectAll:
          selectAllDownloads()
          return
        case CommandIds.TaskPause:
          await actions.onPause()
          return
        case CommandIds.TaskResume:
          await actions.onResume()
          return
        case CommandIds.TaskDelete:
          actions.onRemove()
          return
        case CommandIds.TaskMoveUp:
          await actions.onMove('up')
          return
        case CommandIds.TaskMoveDown:
          await actions.onMove('down')
          return
        case CommandIds.TaskClearStopped:
          confirmClear()
          return
        case CommandIds.TaskPauseAll:
        case CommandIds.TaskResumeAll: {
          const result = (await transport.invoke(
            id === CommandIds.TaskPauseAll
              ? Commands.PauseAllTasks
              : Commands.ResumeAllTasks
          )) as BulkTaskCommandResult
          if (result.failed.length)
            toast.add({
              title: t('panel.downloads.action.batchPartial', {
                ok: result.succeeded.length,
                failed: result.failed.length,
              }),
              type: 'warning',
            })
          return
        }
      }
    } catch {
      toast.add({ title: t('applicationMenu.actionFailed'), type: 'error' })
    }
  }
}
