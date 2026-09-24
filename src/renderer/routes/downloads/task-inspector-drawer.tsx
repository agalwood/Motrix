import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { InspectorDrawer } from '@renderer/components/desktop-kit/inspector-drawer'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { createTaskInspectorActivitySnapshotCache } from '@renderer/hooks/use-task-inspector-activity'
import { transport } from '@renderer/lib/transport'
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
import { useCallback, useLayoutEffect, useMemo } from 'react'
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
import { useTaskInspectorState } from './use-task-inspector-state'
import { type InspectorTab, useDownloadsView } from './view-preferences'

export interface TaskInspectorDrawerProps {
  selection: SelectionStore<DownloadTask>
  tasks: readonly DownloadTask[]
  /** Bounded portal target. The inspector overlays the list without resizing it. */
  container: HTMLElement | null
  onDismiss?: () => void
}

export function TaskInspectorDrawer({
  selection,
  tasks,
  container,
  onDismiss,
}: TaskInspectorDrawerProps) {
  const { t } = useTranslation()
  const { selected, open } = useTaskInspectorState(selection, tasks)
  const visible = useDownloadsView((state) => state.inspectorVisible)
  const snap = useDownloadsView((s) => s.inspectorSnap)
  const setSnap = useDownloadsView((s) => s.setInspectorSnap)
  const single = selected.length === 1 ? selected[0] : null
  const isBt = single?.type === TaskType.Bt || single?.type === TaskType.Magnet
  const showPieces = single !== null && canInspectPieces(single)
  const subtab = useDownloadsView((s) => s.inspectorTab)
  const setSubtab = useDownloadsView((s) => s.setInspectorTab)
  const activitySnapshotCache = useMemo(
    createTaskInspectorActivitySnapshotCache,
    []
  )

  useLayoutEffect(() => {
    // Clearing selection closes the inspector. Selecting another task later
    // must not reopen it without an explicit request to view its details.
    if (visible && selected.length === 0) {
      useDownloadsView.getState().setInspectorVisible(false)
    }
  }, [visible, selected.length])

  const onClose = useCallback(() => {
    onDismiss?.()
    useDownloadsView.getState().setInspectorVisible(false)
  }, [onDismiss])
  const activeSubtab =
    (subtab === 'pieces' && !showPieces) ||
    ((subtab === 'peers' || subtab === 'trackers') && !isBt)
      ? 'overview'
      : subtab

  return (
    <InspectorDrawer
      container={container}
      open={open}
      snap={snap}
      onSnapChange={setSnap}
      onClose={onClose}
      title={t('panel.downloads.view.inspector')}
      resizeLabel={t('panel.downloads.view.resizeInspector')}
      renderHeader={(resizeHandle) => (
        <TaskInspectorActionBar
          selected={selected}
          onClose={onClose}
          resizeHandle={resizeHandle}
        />
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <ScrollAreaViewport
          data-testid="task-inspector-drawer-content"
          className="overscroll-contain"
        >
          <ScrollAreaContent
            className="px-4 pb-4 pt-3"
            style={{ minWidth: '100%' }}
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
                  <StatusPill status={single.status} task={single} />
                </div>
                <Tabs
                  value={activeSubtab}
                  onValueChange={(v) => setSubtab(v as InspectorTab)}
                >
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
                    <OverviewTab
                      task={single}
                      snapshotCache={activitySnapshotCache}
                    />
                  </TabsContent>
                  <TabsContent value="files" className="min-h-0">
                    <FilesTab key={single.id} task={single} />
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
            ) : selected.length > 0 ? (
              <MultiSelectionSummary tasks={selected} />
            ) : null}
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar />
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </InspectorDrawer>
  )
}
