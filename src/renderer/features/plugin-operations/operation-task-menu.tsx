import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import { invokeOperation } from '@renderer/features/plugin-operations/operation-client'
import { Commands } from '@shared/protocol/commands'
import type { OperationDescriptor } from '@shared/schemas/plugin-operations'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OperationIcon } from './operation-icon'
import { useOperationDialog } from './operation-store'
export function OperationTaskMenuItems({
  selected,
  open,
}: {
  selected: DownloadTask[]
  open: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage
  const [items, setItems] = useState<OperationDescriptor[]>([])
  useEffect(() => {
    if (!locale) return
    if (!open) return
    let active = true
    void invokeOperation<{ descriptors: OperationDescriptor[] }>(
      Commands.GetPluginOperations
    )
      .then((state) => {
        if (active) setItems(state.descriptors ?? [])
      })
      .catch(() => {
        if (active) setItems([])
      })
    return () => {
      active = false
    }
  }, [open, locale])
  return items
    .filter((item) =>
      item.definition.entries.some(
        (entry) =>
          entry.surface === 'task-menu' &&
          selected.length >= entry.selection.count.min &&
          selected.length <= entry.selection.count.max &&
          selected.every(
            (task) =>
              task.status === TaskStatus.Completed &&
              task.fileCount <= 1 &&
              task.finalPath
          )
      )
    )
    .map((item) => (
      <DropdownMenuItem
        key={item.definition.id}
        disabled={!!item.unavailable}
        onClick={() =>
          useOperationDialog.getState().openWith({
            pluginId: item.pluginId,
            operationId: item.definition.id,
            taskIds: selected.map((task) => task.id),
          })
        }
      >
        <OperationIcon name={item.definition.icon} />
        {item.definition.title}
        {item.unavailable && ` · ${t(`pluginOperations.${item.unavailable}`)}`}
      </DropdownMenuItem>
    ))
}
