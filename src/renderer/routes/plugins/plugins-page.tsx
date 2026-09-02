import { HeaderActionButton } from '@renderer/components/desktop-kit/panel/header-action-button'
import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { ListFilter, Plus, RefreshCw, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { PluginCard } from './components/plugin-card'
import { PluginGuidance } from './components/plugin-guidance'
import { RegistryPluginCard } from './components/registry-plugin-card'
import { usePlugins } from './hooks/use-plugins'
import { useRegistryPlugins, useRegistryUpdates } from './hooks/use-registry'
import { matchesRegistrySearch } from './lib/registry-text'
import { PluginInstallDialog } from './plugin-install-dialog'
import { usePluginsStore } from './store'

export function PluginsPage() {
  const { t, i18n } = useTranslation()
  const plugins = usePlugins()
  const pluginsLoaded = usePluginsStore((state) => state.loaded)
  const [installOpen, setInstallOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { refreshing, refresh } = useRegistryUpdates(true)
  const refreshLabel = t('plugins.registry.refresh')

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(q) ||
        plugin.description.toLowerCase().includes(q) ||
        plugin.id.toLowerCase().includes(q)
    )
  }, [plugins, searchQuery])

  // Registry entries not installed yet. Search follows the same single
  // resolved/default listing view as cards and details; unrelated translation
  // records are deliberately excluded.
  const registryEntries = useRegistryPlugins()
  const registryLocale = i18n.language
  const available = useMemo(() => {
    const installed = new Set(plugins.map((p) => p.id))
    return registryEntries.filter((entry) => {
      if (installed.has(entry.id)) return false
      return matchesRegistrySearch(entry, searchQuery, registryLocale)
    })
  }, [registryEntries, plugins, searchQuery, registryLocale])

  const hasUserManagedPlugin = plugins.some(
    (plugin) => plugin.source?.type !== 'builtin'
  )
  const diagnosticsLabel = t('plugins.diagnostics.title')

  return (
    <PanelShell
      title={t('plugins.title')}
      actions={
        <HeaderActionButton
          label={t('plugins.install.title')}
          onClick={() => setInstallOpen(true)}
        >
          <Plus aria-hidden />
        </HeaderActionButton>
      }
      contentClassName="min-h-0 px-6 pb-6"
    >
      <div
        data-testid="plugins-tool-row"
        className="flex shrink-0 items-center gap-2 pb-3"
      >
        <div className="relative min-w-0 flex-1">
          <ListFilter
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder={t('plugins.search')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="h-9 rounded-lg bg-background pl-9 text-sm"
          />
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                render={
                  <Link
                    to="/plugins/diagnostics"
                    role="link"
                    aria-label={diagnosticsLabel}
                  />
                }
                nativeButton={false}
                variant="outline"
                size="icon"
              >
                <Workflow aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="bottom">{diagnosticsLabel}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label={refreshLabel}
                data-testid="registry-refresh-btn"
              >
                <RefreshCw
                  aria-hidden
                  className={refreshing ? 'animate-spin' : undefined}
                />
              </Button>
            }
          />
          <TooltipContent side="bottom">{refreshLabel}</TooltipContent>
        </Tooltip>
      </div>

      <div
        data-testid="plugins-scroll-region"
        aria-busy={!pluginsLoaded}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
      >
        {!pluginsLoaded ? (
          <div
            aria-hidden="true"
            className="grid grid-cols-1 gap-2.5 pb-6 lg:grid-cols-2"
          >
            {['primary', 'secondary'].map((placeholder) => (
              <div
                key={placeholder}
                className="space-y-3 rounded-lg border p-4"
              >
                <Skeleton className="h-5 w-2/5" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex w-full flex-col gap-4 pb-6">
            <PluginGuidance hasUserManagedPlugin={hasUserManagedPlugin} />

            {plugins.length === 0 ? null : filtered.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('plugins.searchNoMatch', { query: searchQuery })}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearchQuery('')}
                >
                  {t('plugins.clearSearch')}
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                {filtered.map((plugin) => (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    hasSchema={false}
                  />
                ))}
              </div>
            )}

            {available.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <h3 className="text-sm font-semibold tracking-tight">
                  {t('plugins.registry.availableTitle')}
                </h3>
                <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                  {available.map((entry) => (
                    <RegistryPluginCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <PluginInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
    </PanelShell>
  )
}
