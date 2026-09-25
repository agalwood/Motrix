import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Toolbar } from '@renderer/components/desktop-kit/toolbar/toolbar'
import {
  ToolbarButton,
  ToolbarLink,
} from '@renderer/components/desktop-kit/toolbar/toolbar-button'
import { ToolbarGroup } from '@renderer/components/desktop-kit/toolbar/toolbar-group'
import { ToolbarSearch } from '@renderer/components/desktop-kit/toolbar/toolbar-search'
import { AddIcon, CallGraphIcon, RefreshIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Skeleton } from '@renderer/components/ui/skeleton'
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
        <Toolbar label={t('plugins.title')} data-testid="plugins-tool-row">
          <ToolbarGroup>
            <ToolbarButton
              label={t('plugins.install.title')}
              onClick={() => setInstallOpen(true)}
            >
              <AddIcon aria-hidden="true" />
            </ToolbarButton>
            <ToolbarLink
              label={diagnosticsLabel}
              render={<Link to="/plugins/diagnostics" />}
            >
              <CallGraphIcon aria-hidden="true" />
            </ToolbarLink>
            <ToolbarButton
              label={refreshLabel}
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-busy={refreshing}
              data-testid="registry-refresh-btn"
            >
              <RefreshIcon
                aria-hidden="true"
                className={
                  refreshing
                    ? 'animate-spin motion-reduce:animate-none'
                    : undefined
                }
              />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarSearch
            value={searchQuery}
            onValueChange={setSearchQuery}
            label={t('plugins.search')}
            clearLabel={t('common.clearSearch')}
          />
        </Toolbar>
      }
      actionsDraggable
      actionsClassName="min-w-0 flex-1"
      contentClassName="min-h-0 min-w-0"
    >
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <ScrollAreaViewport
          data-testid="plugins-scroll-region"
          role="region"
          aria-label={t('plugins.title')}
          aria-busy={!pluginsLoaded}
          className="overscroll-contain"
        >
          <ScrollAreaContent className="px-6 pb-6" style={{ minWidth: '100%' }}>
            {!pluginsLoaded ? (
              <div
                aria-hidden="true"
                className="grid grid-cols-1 gap-2.5 lg:grid-cols-2"
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
              <div className="flex w-full flex-col gap-4">
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
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar />
      </ScrollArea>

      <PluginInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
    </PanelShell>
  )
}
