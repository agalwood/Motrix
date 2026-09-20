import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import {
  menuActionEnabled,
  subscribeMenuContext,
} from '@renderer/features/application-menu/task-context'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { openMagnetFileSelection } from '@renderer/lib/open-magnet-file-selection'
import { transport } from '@renderer/lib/transport'
import { CommandIds } from '@shared/commands-catalog'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import {
  type BulkTaskCommandResult,
  canOpenTaskFile,
  canSelectTaskFiles,
} from '@shared/types/task-actions'
import { Ellipsis } from 'lucide-react'
import {
  type ClipboardEvent,
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  type Ref,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadsToolbarButton } from './downloads-toolbar-button'
import { canRevealTaskFolder } from './inspector/can-reveal-task-folder'
import { copyTaskUrls } from './inspector/task-copy-url'
import { taskErrorReport } from './inspector/task-error-report'
import { useTaskActions } from './inspector/use-task-actions'
import { InspectorMenuItem, ListViewSubmenu } from './list-view-menu'
import {
  matchesTaskMenuShortcut,
  taskMenuShortcuts,
} from './task-menu-shortcuts'
import { useTaskInspectorState } from './use-task-inspector-state'
import { useDownloadsView } from './view-preferences'

function GlobalTransferMenuItems({
  pending,
  onAction,
}: {
  pending: boolean
  onAction: (action: 'pause' | 'resume') => void
}) {
  const { t } = useTranslation()
  const canPauseAll = useSyncExternalStore(subscribeMenuContext, () =>
    menuActionEnabled(CommandIds.TaskPauseAll)
  )
  const canResumeAll = useSyncExternalStore(subscribeMenuContext, () =>
    menuActionEnabled(CommandIds.TaskResumeAll)
  )
  return (
    <>
      <DropdownMenuItem
        disabled={pending || !canPauseAll}
        onClick={() => onAction('pause')}
      >
        {t('menu.task.pauseAllTask')}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={pending || !canResumeAll}
        onClick={() => onAction('resume')}
      >
        {t('menu.task.resumeAllTask')}
      </DropdownMenuItem>
    </>
  )
}

export function TaskActionsMenu({
  tasks,
  selection,
  children,
  onHideInspector,
  triggerRef,
}: {
  tasks: readonly DownloadTask[]
  selection: SelectionStore<DownloadTask>
  /** A context trigger must forward DOM props and its ref. */
  children?: ReactElement
  onHideInspector?: () => void
  triggerRef?: Ref<HTMLButtonElement>
}) {
  const { t, i18n } = useTranslation()
  const selectedIds = selection((state) => state.committedSelectedIds)
  const [targetIds, setTargetIds] = useState<ReadonlySet<string> | null>(null)
  const selected = useMemo(
    () => tasks.filter((task) => (targetIds ?? selectedIds).has(task.id)),
    [tasks, targetIds, selectedIds]
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const actions = useTaskActions(selected)
  const single = selected.length === 1 ? selected[0] : null
  const canChooseFiles = single && canSelectTaskFiles(single)
  const hasTransferActions =
    actions.pauseCount +
      actions.resumeCount +
      actions.retryCount +
      actions.reseedCount +
      actions.stopSeedingCount >
      0 ||
    single?.status === TaskStatus.MetadataReady ||
    canChooseFiles ||
    actions.moveCount > 0
  const { open: inspectorVisible } = useTaskInspectorState(selection, tasks)
  const macOS =
    transport.platform === 'darwin' ||
    (transport.platform === 'web' && /Mac|iPhone|iPad/.test(navigator.platform))
  const shortcuts = useMemo(
    () => taskMenuShortcuts(macOS, __MOTRIX_TARGET__ === 'electron'),
    [macOS]
  )
  const taskPath = single?.finalPath || single?.diskPath
  const runAction = async (
    action: () => Promise<unknown>,
    failureTitle: string
  ) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      await action()
    } catch (error) {
      toast.add({
        title: failureTitle,
        description: error instanceof Error ? error.message : String(error),
        type: 'error',
      })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const copy = (action: () => Promise<void>) => {
    void runAction(async () => {
      await action()
      toast.add({ title: t('panel.downloads.action.copied'), type: 'success' })
    }, t('panel.downloads.action.copyFailed'))
  }
  const runAll = (action: 'pause' | 'resume') => {
    const commandId =
      action === 'pause' ? CommandIds.TaskPauseAll : CommandIds.TaskResumeAll
    if (!menuActionEnabled(commandId)) return
    void runAction(async () => {
      const result = (await transport.invoke(
        action === 'pause' ? Commands.PauseAllTasks : Commands.ResumeAllTasks
      )) as BulkTaskCommandResult
      if (result.failed.length)
        toast.add({
          title: t('panel.downloads.action.batchPartial', {
            ok: result.succeeded.length,
            failed: result.failed.length,
          }),
          type: 'warning',
        })
    }, t('applicationMenu.actionFailed'))
  }
  const prepare = () =>
    setTargetIds(new Set(selection.getState().committedSelectedIds))
  const restoreSelection = () => {
    const state = selection.getState()
    if (
      selected.length === state.committedSelectedIds.size &&
      selected.every((task) => state.committedSelectedIds.has(task.id))
    )
      return
    if (!selected[0]) return
    state.select(selected[0].id)
    for (const task of selected.slice(1)) state.toggle(task.id)
  }
  const closeMenu = () => {
    setMenuOpen(false)
    setTargetIds(null)
  }
  const ignoresShortcut = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="separator"]'
      )
    )
  const handleShortcut = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      ignoresShortcut(event.target)
    )
      return
    const action = matchesTaskMenuShortcut(event, shortcuts.inspector)
      ? 'inspector'
      : matchesTaskMenuShortcut(event, shortcuts.copyUrl)
        ? 'copy'
        : matchesTaskMenuShortcut(event, shortcuts.remove)
          ? 'remove'
          : null
    if (!action || (action !== 'inspector' && selected.length === 0)) return
    if (action === 'inspector' && !selected.length && !inspectorVisible) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return
    if (action === 'inspector') {
      if (inspectorVisible) onHideInspector?.()
      else restoreSelection()
      useDownloadsView.getState().setInspectorVisible(!inspectorVisible)
    } else if (action === 'copy') {
      copy(() => copyTaskUrls(selected))
    } else if (actions.removeCount > 0 && !actions.removeDialog.open) {
      actions.onRemove()
    }
    closeMenu()
  }
  // Native Edit > Copy can arrive as a copy event instead of a keydown.
  const handleCopy = (event: ClipboardEvent) => {
    if (
      event.defaultPrevented ||
      ignoresShortcut(event.target) ||
      !selected.length
    )
      return
    event.preventDefault()
    event.stopPropagation()
    copy(() => copyTaskUrls(selected))
    closeMenu()
  }
  const groups = [
    {
      id: 'access',
      visible: selected.length > 0 || !children,
      content: (
        <>
          {single &&
            __MOTRIX_TARGET__ === 'electron' &&
            canOpenTaskFile(single) && (
              <DropdownMenuItem
                disabled={pending}
                onClick={() =>
                  void runAction(
                    () =>
                      transport.invoke(Commands.OpenTaskFile, {
                        taskId: single.id,
                      }),
                    t('panel.downloads.action.openFileFailed')
                  )
                }
              >
                {t('panel.downloads.action.openFile')}
              </DropdownMenuItem>
            )}
          {single &&
            __MOTRIX_TARGET__ === 'electron' &&
            canRevealTaskFolder(single) && (
              <DropdownMenuItem
                onClick={() => {
                  void transport
                    .invoke(Commands.RevealInFolder, { taskId: single.id })
                    .catch((error: unknown) =>
                      toast.add({
                        title: t('panel.downloads.action.singleTaskFailed', {
                          name: single.name,
                          reason: String(error),
                        }),
                        type: 'error',
                      })
                    )
                }}
              >
                {t('panel.downloads.action.openFolder')}
              </DropdownMenuItem>
            )}
          <InspectorMenuItem
            visible={inspectorVisible}
            disabled={!inspectorVisible && selected.length === 0}
            onHide={onHideInspector}
            onShow={restoreSelection}
            shortcut={shortcuts.inspector}
          />
          {!children && <ListViewSubmenu />}
        </>
      ),
    },
    {
      id: 'transfer',
      visible: hasTransferActions,
      content: (
        <>
          {actions.pauseCount > 0 && (
            <DropdownMenuItem onClick={() => void actions.onPause()}>
              {t('panel.downloads.action.pause')}
            </DropdownMenuItem>
          )}
          {actions.resumeCount > 0 && (
            <DropdownMenuItem onClick={() => void actions.onResume()}>
              {t('panel.downloads.action.resume')}
            </DropdownMenuItem>
          )}
          {actions.stopSeedingCount > 0 && (
            <DropdownMenuItem onClick={() => void actions.onStopSeeding()}>
              {t('panel.downloads.action.stopSeeding')}
            </DropdownMenuItem>
          )}
          {actions.retryCount > 0 && (
            <DropdownMenuItem onClick={() => void actions.onRetry()}>
              {t('panel.downloads.action.retry')}
            </DropdownMenuItem>
          )}
          {actions.reseedCount > 0 && (
            <DropdownMenuItem onClick={() => void actions.onReseed()}>
              {t('panel.downloads.action.reseed')}
            </DropdownMenuItem>
          )}
          {single?.status === TaskStatus.MetadataReady && (
            <DropdownMenuItem
              disabled={pending}
              onClick={() =>
                void runAction(
                  () => openMagnetFileSelection(single.id),
                  t('panel.downloads.action.selectFilesFailed')
                )
              }
            >
              {t('panel.downloads.action.selectFiles')}
            </DropdownMenuItem>
          )}
          {canChooseFiles && (
            <DropdownMenuItem
              onClick={() => {
                selection.getState().select(single.id)
                useDownloadsView.getState().setInspectorTab('files')
                useDownloadsView.getState().setInspectorVisible(true)
              }}
            >
              {t('panel.downloads.action.chooseFiles')}
            </DropdownMenuItem>
          )}
          {actions.moveCount > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={actions.moving}>
                {t('panel.downloads.action.queueOrder')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                data-menu-density="compact"
                className="w-max min-w-44 max-w-[min(18rem,var(--available-width))]"
              >
                {(
                  [
                    ['up', 'moveQueueUp'],
                    ['down', 'moveQueueDown'],
                    ['top', 'moveQueueTop'],
                    ['bottom', 'moveQueueBottom'],
                  ] as const
                ).map(([direction, label]) => (
                  <Fragment key={direction}>
                    {direction === 'top' && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      disabled={actions.moving}
                      onClick={() => void actions.onMove(direction)}
                    >
                      {t(`panel.downloads.action.${label}`)}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </>
      ),
    },
    {
      id: 'all-transfers',
      visible: !children,
      content: <GlobalTransferMenuItems pending={pending} onAction={runAll} />,
    },
    {
      id: 'copy',
      visible: selected.length > 0,
      content: (
        <>
          <DropdownMenuItem
            aria-keyshortcuts={shortcuts.copyUrl.aria}
            disabled={selected.length === 0 || pending}
            onClick={() => copy(() => copyTaskUrls(selected))}
          >
            {t(
              selected.length > 1
                ? 'panel.downloads.action.copyUrls'
                : 'panel.downloads.action.copyUrl'
            )}
            <DropdownMenuShortcut aria-hidden="true">
              {shortcuts.copyUrl.label}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          {taskPath && (
            <DropdownMenuItem
              disabled={pending}
              onClick={() =>
                copy(() => navigator.clipboard.writeText(taskPath))
              }
            >
              {t('panel.downloads.action.copyPath')}
            </DropdownMenuItem>
          )}
          {selected.some((task) => task.status === TaskStatus.Error) && (
            <DropdownMenuItem
              disabled={pending}
              onClick={() =>
                copy(() =>
                  navigator.clipboard.writeText(
                    taskErrorReport(selected, {
                      t,
                      exists: (key) => i18n.exists(key),
                    })
                  )
                )
              }
            >
              {t('panel.downloads.action.copyError')}
            </DropdownMenuItem>
          )}
        </>
      ),
    },
    {
      id: 'create',
      visible: true,
      content: (
        <DropdownMenuItem
          disabled={pending}
          aria-keyshortcuts={shortcuts.newTask?.aria}
          onClick={() =>
            void runAction(() => openAddTaskDialog(), t('common.error'))
          }
        >
          {t('menu.task.newTask')}
          {shortcuts.newTask && (
            <DropdownMenuShortcut aria-hidden="true">
              {shortcuts.newTask.label}
            </DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
      ),
    },
    {
      id: 'remove',
      visible: actions.removeCount > 0,
      content: (
        <DropdownMenuItem
          variant="destructive"
          aria-keyshortcuts={shortcuts.remove.aria}
          onClick={() => actions.onRemove()}
        >
          {t('panel.downloads.action.remove')}
          <DropdownMenuShortcut aria-hidden="true">
            {shortcuts.remove.label}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      ),
    },
  ].filter((group) => group.visible)
  const items = groups.map((group, index) => (
    <Fragment key={group.id}>
      {index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuGroup>{group.content}</DropdownMenuGroup>
    </Fragment>
  ))
  if (children)
    return (
      <ContextMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) prepare()
          else setTargetIds(null)
          setMenuOpen(open)
        }}
      >
        <ContextMenuTrigger
          render={children}
          onKeyDownCapture={handleShortcut}
          onCopyCapture={handleCopy}
          onContextMenuCapture={(event) => {
            const row = (event.target as Element).closest<HTMLElement>(
              '[data-task-id]'
            )
            if (!row?.dataset.taskId) return
            const state = selection.getState()
            if (!state.selectedIds.has(row.dataset.taskId))
              state.select(row.dataset.taskId)
            state.focus(row.dataset.taskId)
            prepare()
          }}
        />
        <ContextMenuContent
          onKeyDownCapture={handleShortcut}
          onCopyCapture={handleCopy}
          className="w-max min-w-48 max-w-[min(18rem,var(--available-width))]"
        >
          {items}
        </ContextMenuContent>
      </ContextMenu>
    )
  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        if (open) prepare()
        else setTargetIds(null)
        setMenuOpen(open)
      }}
    >
      <DropdownMenuTrigger
        onKeyDownCapture={handleShortcut}
        onCopyCapture={handleCopy}
        render={
          <DownloadsToolbarButton
            aria-label={t('panel.downloads.view.taskActions')}
            title={t('panel.downloads.view.taskActions')}
            ref={triggerRef}
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onKeyDownCapture={handleShortcut}
        onCopyCapture={handleCopy}
        align="end"
        data-menu-density="compact"
        className="w-max min-w-48 max-w-[min(18rem,var(--available-width))]"
      >
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
