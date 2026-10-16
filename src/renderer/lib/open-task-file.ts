import { toast } from '@renderer/components/ui/toast'
import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { TransportError } from '@shared/protocol/errors'
import type { TFunction } from 'i18next'
import { transport } from './transport'

/** Shared failure presentation for the context menu and task inspector. */
export async function openTaskFile(
  taskId: string,
  t: TFunction
): Promise<void> {
  try {
    await transport.invoke(Commands.OpenTaskFile, { taskId })
  } catch (error) {
    toast.add({
      title: t('panel.downloads.action.openFileFailed'),
      description: t(
        error instanceof TransportError &&
          error.code === ErrorCode.TaskOpenAppFailed
          ? 'panel.downloads.action.openFileAppFailed'
          : 'panel.downloads.action.openFileFailedHint'
      ),
      type: 'error',
    })
  }
}
