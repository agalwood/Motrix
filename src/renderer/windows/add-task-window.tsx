import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { Toaster } from '@renderer/components/ui/toast'
import { useAdaptiveWindowHeight } from '@renderer/hooks/use-adaptive-window-height'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import {
  ADD_TASK_COLLAPSED_HEIGHT,
  ADD_TASK_MAX_HEIGHT,
} from '@shared/constants/add-task'
import {
  addTaskUrlParamsSchema,
  urlParamsToFormDefaults,
} from '@shared/schemas/add-task'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { WindowChrome } from '../components/window-chrome/window-chrome'

export function AddTaskWindow() {
  const { t } = useTranslation()

  useAdaptiveWindowHeight({
    width: 640,
    minHeight: ADD_TASK_COLLAPSED_HEIGHT,
    maxHeight: ADD_TASK_MAX_HEIGHT,
    enabled: __MOTRIX_TARGET__ === 'electron',
  })

  const defaultValues = useMemo(() => {
    if (typeof window === 'undefined') return undefined
    const params = Object.fromEntries(
      new URLSearchParams(window.location.search)
    )
    const parsed = addTaskUrlParamsSchema.safeParse(params)
    if (!parsed.success) return undefined
    return urlParamsToFormDefaults(parsed.data)
  }, [])

  return (
    <div className="flex h-screen flex-col">
      <WindowChrome
        variant="titled"
        compact
        maximizable={false}
        title={t('task.add.title')}
      />
      <PlatformServicesProvider services={electronServices}>
        <AddTaskForm
          defaultValues={defaultValues}
          onSubmitSuccess={(taskId) =>
            void electronServices.closeHost({
              showMain: true,
              navigateMainTo: `/downloads/all?task=${encodeURIComponent(taskId)}`,
            })
          }
          onCancel={() => void electronServices.closeHost({ showMain: true })}
          subscribeEvents
        />
      </PlatformServicesProvider>
      <Toaster />
    </div>
  )
}
