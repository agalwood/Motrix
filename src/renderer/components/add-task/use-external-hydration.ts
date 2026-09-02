import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import {
  type AddTaskFormValues,
  magnetFileSelectionPayloadSchema,
  protocolTorrentFilePayloadSchema,
  setAddTaskModeEventPayloadSchema,
  torrentQueueSizeChangedPayloadSchema,
  urlParamsToFormDefaults,
} from '@shared/schemas/add-task'
import { useEffect } from 'react'
import type { UseFormReturn } from 'react-hook-form'

export interface AddTaskModeHydrationContext {
  refreshDefaultSaveDir: boolean
}

export interface TorrentQueueState {
  queuePosition: number
  queueTotal: number
}

export type TorrentQueueUpdate =
  | TorrentQueueState
  | { queueTotal: number }
  | null

export function useExternalHydration(
  form: UseFormReturn<AddTaskFormValues>,
  enabled: boolean,
  onModeHydrated?: (context: AddTaskModeHydrationContext) => void,
  onTorrentQueueChanged?: (update: TorrentQueueUpdate) => void
) {
  useEffect(() => {
    if (!enabled) return

    const onMagnet = (...args: unknown[]) => {
      const parsed = magnetFileSelectionPayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      onTorrentQueueChanged?.(null)
      form.reset(
        {
          tab: 'torrent',
          source: 'magnet',
          magnetUri: parsed.data.magnetUri,
          base64: parsed.data.torrentBase64,
          torrentMeta: parsed.data.meta,
          selectedFiles: parsed.data.meta.files.map((f) => f.index),
          saveDir: parsed.data.saveDir,
          // Plan B: thread the metadata pending task's motrixId
          // through so the CreateTask handler can swap the instance
          // in place instead of creating a duplicate row.
          existingTaskId: parsed.data.taskId,
        },
        { keepErrors: false }
      )
    }

    const onProtocol = (...args: unknown[]) => {
      const parsed = protocolTorrentFilePayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      onTorrentQueueChanged?.({
        queuePosition: parsed.data.queuePosition,
        queueTotal: parsed.data.queueTotal,
      })
      form.reset(
        {
          tab: 'torrent',
          source: 'file',
          base64: parsed.data.payload.dataBase64,
          torrentMeta: parsed.data.meta,
          selectedFiles: parsed.data.meta.files.map((f) => f.index),
          saveDir: form.getValues('saveDir'),
        },
        { keepErrors: false }
      )
    }

    const onSetMode = (...args: unknown[]) => {
      const parsed = setAddTaskModeEventPayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      onTorrentQueueChanged?.(null)
      const defaults = urlParamsToFormDefaults(parsed.data)
      const refreshDefaultSaveDir =
        defaults.saveDir === undefined && !form.getFieldState('saveDir').isDirty
      // A mode switch without an explicit saveDir must not wipe whatever
      // is already in the field before the current default is refreshed.
      // A dirty value is a per-task user override and remains authoritative.
      if (defaults.saveDir === undefined) {
        defaults.saveDir = form.getValues('saveDir')
      }
      form.reset(defaults as Partial<AddTaskFormValues>, {
        keepErrors: false,
      })
      onModeHydrated?.({ refreshDefaultSaveDir })
    }

    const onTorrentQueueSizeChanged = (...args: unknown[]) => {
      const parsed = torrentQueueSizeChangedPayloadSchema.safeParse(args[0])
      if (!parsed.success) return
      onTorrentQueueChanged?.(parsed.data)
    }

    transport.on(Events.MagnetFileSelection, onMagnet)
    transport.on(Events.ProtocolTorrentFile, onProtocol)
    transport.on(Events.SetAddTaskMode, onSetMode)
    transport.on(Events.TorrentQueueSizeChanged, onTorrentQueueSizeChanged)

    return () => {
      transport.off(Events.MagnetFileSelection, onMagnet)
      transport.off(Events.ProtocolTorrentFile, onProtocol)
      transport.off(Events.SetAddTaskMode, onSetMode)
      transport.off(Events.TorrentQueueSizeChanged, onTorrentQueueSizeChanged)
    }
  }, [form, enabled, onModeHydrated, onTorrentQueueChanged])
}
