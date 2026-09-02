import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { createTaskInspectorActivitySnapshotCache } from '@renderer/hooks/use-task-inspector-activity'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskType } from '@shared/types/task'
import { canInspectPieces } from '@shared/types/task-actions'
import {
  Files,
  Grid3x3,
  HardDrive,
  Info,
  RadioTower,
  SquareActivity,
  UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ActivityTab } from './inspector/activity-tab'
import { canRevealTaskFolder } from './inspector/can-reveal-task-folder'
import { FilesTab } from './inspector/files-tab'
import { MultiSelectionSummary } from './inspector/multi-selection-summary'
import { OverviewTab } from './inspector/overview-tab'
import { PeersTab } from './inspector/peers-tab'
import { PiecesTab } from './inspector/pieces-tab'
import { TaskInspectorActionBar } from './inspector/task-inspector-action-bar'
import { TrackersTab } from './inspector/trackers-tab'
import { StatusPill } from './status-pill'

type SubTab =
  | 'overview'
  | 'files'
  | 'pieces'
  | 'peers'
  | 'trackers'
  | 'activity'

export interface TaskInspectorDrawerProps {
  selection: SelectionStore<DownloadTask>
  tasks: readonly DownloadTask[]
  /** Portal target. Must have `position: relative`. Drawer does not render when null. */
  container: HTMLElement | null
  onDismiss?: () => void
}

function useSelectedTasks(
  selection: SelectionStore<DownloadTask>,
  tasks: readonly DownloadTask[]
): DownloadTask[] {
  const ids = selection((s) => s.committedSelectedIds)
  return useMemo(() => tasks.filter((t) => ids.has(t.id)), [ids, tasks])
}

export function TaskInspectorDrawer({
  selection,
  tasks,
  container,
  onDismiss,
}: TaskInspectorDrawerProps) {
  const { t } = useTranslation()
  const selected = useSelectedTasks(selection, tasks)
  const clear = selection((s) => s.clearSelection)
  const open = selected.length > 0
  const single = selected.length === 1 ? selected[0] : null
  const isBt = single?.type === TaskType.Bt || single?.type === TaskType.Magnet
  const showPieces = single !== null && canInspectPieces(single)
  const [subtab, setSubtab] = useState<SubTab>('overview')
  const activitySnapshotCache = useMemo(
    createTaskInspectorActivitySnapshotCache,
    []
  )

  const onClose = useCallback(() => {
    onDismiss?.()
    clear()
  }, [clear, onDismiss])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (
        e.target instanceof Element &&
        e.target.closest('[data-activity-detail-surface="true"]')
      ) {
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const drawer = open ? (
    <div
      role="dialog"
      aria-label={t('panel.downloads.title')}
      className={cn(
        'drawer-slide-in absolute inset-x-0 bottom-0 z-30 flex flex-col',
        subtab === 'activity' ? 'max-h-[85%]' : 'max-h-[80%]',
        'border-t border-border bg-background',
        'shadow-[0_-6px_20px_rgba(15,23,42,0.1)]'
      )}
    >
      <TaskInspectorActionBar selected={selected} onClose={onClose} />

      <div
        data-testid="task-inspector-drawer-content"
        className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-3"
      >
        {single ? (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <div className="min-w-0 flex items-center gap-2">
                  <Badge
                    variant="default"
                    className="shrink-0 rounded px-2 py-0 text-[10px]"
                  >
                    {single.type.toUpperCase()}
                  </Badge>
                  <span className="min-w-0 truncate text-sm font-medium">
                    {single.name}
                  </span>
                </div>

                {__MOTRIX_TARGET__ === 'electron' &&
                  canRevealTaskFolder(single) && (
                    <div className="min-w-0 flex items-center gap-1 text-xs text-muted-foreground">
                      <Button
                        className="min-w-0 flex-1 justify-start overflow-hidden text-muted-foreground hover:no-underline cursor-pointer"
                        variant="secondary"
                        size="xs"
                        dir="ltr"
                        onClick={() =>
                          transport.invoke(Commands.RevealInFolder, {
                            taskId: single.id,
                          })
                        }
                      >
                        <HardDrive className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {single.finalPath || single.diskPath}
                        </span>
                      </Button>
                      <CopyButton
                        variant="ghost"
                        className="ml-1 h-4.5 w-4.5 shrink-0 rounded-md p-0 has-[>svg]:px-0 [&_svg:not([class*='size-'])]:size-3"
                        content={single.finalPath || single.diskPath}
                      />
                    </div>
                  )}
              </div>
              <StatusPill status={single.status} />
            </div>
            <Tabs value={subtab} onValueChange={(v) => setSubtab(v as SubTab)}>
              <TabsList className="mb-1 bg-tab-background">
                <TabsTrigger
                  value="overview"
                  className="text-xs px-5"
                  aria-label={t('panel.downloads.inspector.tab.overview')}
                  title={t('panel.downloads.inspector.tab.overview')}
                >
                  <Info className="size-3.5" />
                </TabsTrigger>
                <TabsTrigger
                  value="files"
                  className="text-xs px-5"
                  aria-label={t('panel.downloads.inspector.tab.files')}
                  title={t('panel.downloads.inspector.tab.files')}
                >
                  <Files className="size-3.5" />
                </TabsTrigger>
                {showPieces && (
                  <TabsTrigger
                    value="pieces"
                    className="text-xs px-5"
                    aria-label={t('panel.downloads.inspector.tab.pieces')}
                    title={t('panel.downloads.inspector.tab.pieces')}
                  >
                    <Grid3x3 className="size-3.5" />
                  </TabsTrigger>
                )}
                {isBt && (
                  <TabsTrigger
                    value="peers"
                    className="text-xs px-5"
                    aria-label={t('panel.downloads.inspector.tab.peers')}
                    title={t('panel.downloads.inspector.tab.peers')}
                  >
                    <UsersRound className="size-3.5" />
                  </TabsTrigger>
                )}
                {isBt && (
                  <TabsTrigger
                    value="trackers"
                    className="text-xs px-5"
                    aria-label={t('panel.downloads.inspector.tab.trackers')}
                    title={t('panel.downloads.inspector.tab.trackers')}
                  >
                    <RadioTower className="size-3.5" />
                  </TabsTrigger>
                )}
                <TabsTrigger
                  value="activity"
                  className="text-xs px-5"
                  aria-label={t('panel.downloads.inspector.tab.activity')}
                  title={t('panel.downloads.inspector.tab.activity')}
                >
                  <SquareActivity className="size-3.5" />
                </TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="min-h-0">
                <OverviewTab task={single} />
              </TabsContent>
              <TabsContent value="files" className="min-h-0">
                <FilesTab task={single} />
              </TabsContent>
              {showPieces && (
                <TabsContent value="pieces" className="min-h-0">
                  <PiecesTab task={single} />
                </TabsContent>
              )}
              {isBt && (
                <TabsContent value="peers" className="min-h-0">
                  <PeersTab task={single} />
                </TabsContent>
              )}
              {isBt && (
                <TabsContent value="trackers" className="min-h-0">
                  <TrackersTab task={single} />
                </TabsContent>
              )}
              <TabsContent value="activity" className="min-h-0">
                <ActivityTab
                  task={single}
                  snapshotCache={activitySnapshotCache}
                />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <MultiSelectionSummary tasks={selected} />
        )}
      </div>
    </div>
  ) : null

  return container && drawer ? createPortal(drawer, container) : null
}
