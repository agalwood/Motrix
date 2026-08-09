import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { useAdaptiveWindowHeight } from '@renderer/hooks/use-adaptive-window-height'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
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
    minHeight: 360,
    maxHeight: 760,
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
      <WindowChrome variant="titled" compact title={t('task.add.title')} />
      <PlatformServicesProvider services={electronServices}>
        <AddTaskForm
          defaultValues={defaultValues}
          onSubmitSuccess={() =>
            void electronServices.closeHost({
              showMain: true,
              navigateMainTo: '/downloads',
            })
          }
          onCancel={() => void electronServices.closeHost({ showMain: true })}
          subscribeEvents
        />
      </PlatformServicesProvider>
    </div>
  )
}
