import {
  PANEL_TITLE_CLASS,
  PanelShell,
} from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { toast } from '@renderer/components/ui/toast'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import type { JsonSchemaNode, PluginManifestDTO } from '@shared/types/plugin'
import { CircleFadingArrowUp, RefreshCw, ScrollText, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { AccessSection } from './components/access-section'
import { BuiltinUpdateDialog } from './components/builtin-update-dialog'
import { OverviewSection } from './components/overview-section'
import { PluginLogTab } from './components/plugin-log-tab'
import { PluginSettingsForm } from './components/plugin-settings-form'
import { PluginStatusDot } from './components/plugin-status-dot'
import { RegistryDetailPanel } from './components/registry-detail-panel'
import { UninstallSection } from './components/uninstall-section'
import { usePluginDetail } from './hooks/use-plugin-detail'
import { usePlugins } from './hooks/use-plugins'
import { useRegistryEntry, useRegistryUpdates } from './hooks/use-registry'
import { PluginInstallDialog } from './plugin-install-dialog'
import { type UpdateChannel, usePluginsStore } from './store'

type DetailTab = 'overview' | 'settings' | 'access' | 'logs' | 'about'

export function PluginDetailPage() {
  const { id = '' } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const detail = usePluginDetail(id)
  const platform = usePlatformServices()
  const isElectron = platform.kind === 'electron'
  // Deeplinks (motrix://plugins/<id>) mount this sibling route directly, so
  // PluginsPage — the only other caller — never runs. Trigger the update scan
  // here too so the "Update to vX" affordance appears on cold-start deeplinks.
  // Cache-backed on both shells, mirroring PluginsPage. Server scans only the
  // community channel; builtin overlay updates remain Electron-only.
  const { refreshing, refresh } = useRegistryUpdates(true)
  usePlugins()
  const pluginsLoaded = usePluginsStore((s) => s.loaded)
  const listEntry = usePluginsStore((s) => s.list.find((p) => p.id === id))
  const applyStatus = usePluginsStore((s) => s.applyStatus)
  const update = usePluginsStore((s) => s.updates[id])
  const [updateOpen, setUpdateOpen] = useState(false)
  // Snapshot of update.channel taken when the dialog opens. The dialog's own
  // success path clears the store entry while the dialog is still open, so
  // keying the rendered dialog on the live `update` would swap a finished
  // BuiltinUpdateDialog into an auto-installing community PluginInstallDialog
  // mid-flight (which main then rejects — motrix.* is a reserved namespace).
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel | null>(null)

  const initialTab = (searchParams.get('tab') ?? 'overview') as DetailTab
  const [tab, setTab] = useState<DetailTab>(initialTab)
  useEffect(() => {
    setTab((searchParams.get('tab') ?? 'overview') as DetailTab)
  }, [searchParams])

  // Not-installed ids fall back to the registry-backed view (the landing
  // surface of motrix://plugins/<id>). Only when the id is in neither the
  // installed list nor the registry do we bounce to the list with a toast.
  const { checked: registryChecked, entry: registryEntry } =
    useRegistryEntry(id)
  useEffect(() => {
    if (pluginsLoaded && !listEntry && registryChecked && !registryEntry) {
      toast.add({ title: t('plugins.registry.notFound', { id }) })
      navigate('/plugins', { replace: true })
    }
  }, [
    pluginsLoaded,
    listEntry,
    registryChecked,
    registryEntry,
    navigate,
    t,
    id,
  ])

  if (!detail || !listEntry) {
    if (pluginsLoaded && !listEntry && registryEntry) {
      return <RegistryDetailPanel entry={registryEntry} />
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('plugins.detail.loading')}
      </div>
    )
  }

  const manifest = detail.manifest as PluginManifestDTO
  const schema = manifest.contributes.configuration?.schema as
    | JsonSchemaNode
    | undefined

  async function toggleEnabled(next: boolean) {
    await transport.invoke(
      next ? Commands.EnablePlugin : Commands.DisablePlugin,
      id
    )
    applyStatus(id, next ? 'inactive' : 'disabled', undefined, next)
  }

  return (
    <>
      <PanelShell
        title={
          // The title shares the same h-8 -> h-4 box as the actions (below) so
          // both columns are equal height under the header's items-start: equal
          // height + pinned tops => co-centered, keeping the title and the switch
          // vertically aligned in both sidebar states. PANEL_TITLE_CLASS makes
          // the name track the toggle (text-2xl -> text-sm on collapse).
          // leading-none then tightens the line box to the glyph height so the
          // status dot centers on the text's optical middle rather than floating
          // in text-2xl's tall 2rem leading (it would otherwise read as too low).
          // overflow-x-clip keeps the horizontal ellipsis while leaving the
          // vertical axis visible, so the tight leading never clips descenders
          // (g/y/p); the dot stays shrink-0.
          <div className="flex h-8 min-w-0 items-center gap-2 compact-header:h-7">
            <h1
              className={cn(
                PANEL_TITLE_CLASS,
                'min-w-0 overflow-x-clip whitespace-nowrap text-ellipsis leading-none'
              )}
            >
              {manifest.name}
            </h1>
            <span className="shrink-0">
              <PluginStatusDot
                status={listEntry.status}
                enabled={listEntry.enabled}
              />
            </span>
          </div>
        }
        actions={
          // h-8 / h-4 pins the switch box to the title's line height per sidebar
          // state (32px expanded, 16px collapsed) so the control stays centered
          // against the title in both states — same size-align trick the
          // downloads header uses for its title/search pair.
          <div className="flex h-8 items-center gap-3 compact-header:h-7">
            <Switch
              id="plugin-detail-enabled"
              aria-label={t('plugins.detail.enabled')}
              checked={listEntry.enabled}
              onCheckedChange={toggleEnabled}
            />
          </div>
        }
        contentClassName="min-h-0 px-6 pb-6"
      >
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as DetailTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex w-full shrink-0 items-center justify-between pb-2">
            <TabsList>
              <TabsTrigger value="overview">
                {t('plugins.detail.overview')}
              </TabsTrigger>
              {schema && (
                <TabsTrigger value="settings">
                  {t('plugins.detail.settings')}
                </TabsTrigger>
              )}
              <TabsTrigger value="access">
                {t('plugins.detail.access')}
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-1.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={tab === 'logs' ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        onClick={() => setTab('logs')}
                        aria-label={t('plugins.detail.logs')}
                      >
                        <ScrollText className="size-4 text-foreground" />
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {t('plugins.detail.logs')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {(isElectron || update?.channel !== 'builtin') && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      update ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            setUpdateChannel(update.channel)
                            setUpdateOpen(true)
                          }}
                          aria-label={t('plugins.registry.updateTo', {
                            version: update.latestVersion,
                          })}
                          data-testid="plugin-update-btn"
                        >
                          <CircleFadingArrowUp className="size-4 text-foreground" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void refresh()}
                          disabled={refreshing}
                          aria-label={t('plugins.registry.refresh')}
                          data-testid="plugin-detail-refresh-btn"
                        >
                          <RefreshCw
                            className={cn(
                              'size-4 text-foreground',
                              refreshing && 'animate-spin'
                            )}
                          />
                        </Button>
                      )
                    }
                  />
                  <TooltipContent side="bottom">
                    {update
                      ? t('plugins.registry.updateTo', {
                          version: update.latestVersion,
                        })
                      : t('plugins.registry.refresh')}
                  </TooltipContent>
                </Tooltip>
              )}
              {platform.kind === 'electron' &&
                listEntry.source?.type === 'builtin-update' && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          data-testid="builtin-revert-btn"
                          aria-label={t('plugins.registry.revertToBundled')}
                          onClick={async () => {
                            try {
                              const resp = (await transport.invoke(
                                Commands.RevertBuiltinToBundled,
                                { pluginId: id }
                              )) as { restartRequired?: boolean }
                              // The list refresh (status/source.type flipping
                              // back to 'builtin') comes from the main-side
                              // Events.PluginInstalled emission picked up by
                              // usePlugins.onLifecycle — no manual refetch
                              // needed here.
                              if (resp.restartRequired) {
                                toast.add({
                                  title: t('plugins.registry.restartRequired'),
                                })
                              }
                            } catch {
                              toast.add({
                                title: t('plugins.registry.actionFailed'),
                              })
                            }
                          }}
                        >
                          <Undo2 className="size-4 text-foreground" />
                        </Button>
                      }
                    />
                    <TooltipContent side="bottom">
                      {t('plugins.registry.revertToBundled')}
                    </TooltipContent>
                  </Tooltip>
                )}
              <UninstallSection
                pluginId={id}
                pluginName={manifest.name}
                hidden={listEntry.source?.type === 'builtin'}
              />
            </div>
          </div>

          <TabsContent
            value="overview"
            className="m-0 min-h-0 flex-1 overflow-auto pb-6"
          >
            <div className="mx-auto flex w-full flex-col gap-4">
              <OverviewSection
                plugin={listEntry}
                manifest={manifest}
                onJumpToLogs={() => setTab('logs')}
              />
            </div>
          </TabsContent>

          {schema && (
            <TabsContent
              value="settings"
              className="m-0 min-h-0 flex-1 overflow-auto pb-6"
            >
              <div className="mx-auto flex w-full flex-col gap-4">
                <PluginSettingsForm
                  pluginId={id}
                  schema={schema}
                  initialValues={detail.config}
                />
              </div>
            </TabsContent>
          )}

          <TabsContent
            value="access"
            className="m-0 min-h-0 flex-1 overflow-auto pb-6"
          >
            <div className="mx-auto flex w-full flex-col gap-4">
              <AccessSection
                manifest={manifest}
                grants={detail.grants}
                // Builtin / dev plugins are trusted: the host auto-grants all
                // declared permissions and rejects grant mutations
                // (updateGrants → plugin.grants.not_supported). Render their
                // optional permissions read-only so the toggle never fires that
                // rejected command (which surfaced as an uncaught promise error).
                trusted={
                  listEntry.source?.type === 'builtin' ||
                  listEntry.source?.type === 'dev'
                }
                onToggleGrant={async (permission) => {
                  const next =
                    detail.grants[permission] === 'granted'
                      ? 'denied'
                      : 'granted'
                  await transport.invoke(Commands.UpdatePluginGrants, {
                    pluginId: id,
                    patch: { [permission]: next },
                  })
                  // usePluginDetail re-fetches via PluginGrantsChanged event;
                  // no local mutation needed.
                }}
              />
            </div>
          </TabsContent>

          <TabsContent value="logs" className="m-0 flex min-h-0 flex-1">
            <PluginLogTab pluginId={id} />
          </TabsContent>
        </Tabs>
      </PanelShell>

      {updateChannel !== null &&
        (updateChannel === 'builtin' ? (
          <BuiltinUpdateDialog
            pluginId={id}
            open={updateOpen}
            onOpenChange={setUpdateOpen}
          />
        ) : (
          <PluginInstallDialog
            open={updateOpen}
            onOpenChange={setUpdateOpen}
            fixedSource={{ sourceType: 'registry', pluginId: id }}
          />
        ))}
    </>
  )
}
