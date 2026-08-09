import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { useGeoIPStatus } from '@renderer/hooks/use-geoip-status'
import { useTaskPeers } from '@renderer/hooks/use-task-peers'
import { countryCodeToFlag, countryName } from '@renderer/lib/country-flag'
import { formatBytes } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { TaskPeer } from '@shared/types/peer'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

// Statuses where the peer set is actively changing and warrants the 2s
// polling cadence. Other states (queued / paused / completed / error /
// removed) still fetch once on mount — typically returning an empty list
// — but stop polling after that.
const PEER_LIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

const ROW_HEIGHT = 28
// Two grid templates: with vs. without the GeoIP columns. The active
// one is chosen at render time by PeersTab so disabled GeoIP doesn't
// burn 64px of layout for empty cells.
const GRID_COLS_WITH_GEO =
  'grid-cols-[28px_36px_minmax(0,2fr)_minmax(0,3fr)_72px_72px_64px_56px]'
const GRID_COLS_BASE =
  'grid-cols-[minmax(0,2fr)_minmax(0,3fr)_72px_72px_64px_56px]'

/**
 * Compose the BT peer flags column. Mirrors the convention used by
 * Transmission / qBittorrent: each char represents one boolean state,
 * an underscore means "no/false". Reading order: down (peer chokes us),
 * up (we choke peer), seeder.
 */
export function flagsString(peer: TaskPeer): string {
  const down = peer.peerChoking ? '_' : 'D'
  const up = peer.amChoking ? '_' : 'U'
  const seed = peer.seeder ? 'S' : '_'
  return `${down}${up}${seed}`
}

export function clientLabel(peer: TaskPeer): string {
  if (!peer.client) return '—'
  return peer.clientVersion
    ? `${peer.client} ${peer.clientVersion}`
    : peer.client
}

interface PeerRowProps {
  peer: TaskPeer
  /** Active UI locale, used to resolve the country tooltip. */
  locale: string
  /** When false, the flag + code columns are omitted entirely. */
  showCountry: boolean
}

export function PeerRow({ peer, locale, showCountry }: PeerRowProps) {
  const progressPct = Math.round(peer.progress * 100)
  const flag = peer.country ? countryCodeToFlag(peer.country.code) : ''
  const code = peer.country?.code ?? ''
  const fullName = peer.country
    ? countryName(peer.country.code, locale) || peer.country.name
    : ''
  return (
    <div
      className={cn(
        'grid h-7',
        showCountry ? GRID_COLS_WITH_GEO : GRID_COLS_BASE,
        'items-center gap-3 px-3 text-xs tabular-nums',
        'border-b border-border/40 last:border-b-0'
      )}
    >
      {showCountry && (
        <>
          <span className="text-base leading-none" aria-hidden="true">
            {flag}
          </span>
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={fullName}
          >
            {code}
          </span>
        </>
      )}
      <span className="truncate text-foreground">
        {peer.ip}
        <span className="text-muted-foreground">:{peer.port}</span>
      </span>
      <span
        className="truncate text-muted-foreground"
        title={clientLabel(peer)}
      >
        {clientLabel(peer)}
      </span>
      <span className="text-right text-muted-foreground">
        {peer.downSpeed > 0 ? `${formatBytes(peer.downSpeed)}/s` : '—'}
      </span>
      <span className="text-right text-muted-foreground">
        {peer.upSpeed > 0 ? `${formatBytes(peer.upSpeed)}/s` : '—'}
      </span>
      <span className="text-right text-muted-foreground">{progressPct}%</span>
      <span className="text-right text-[11px] text-muted-foreground">
        {flagsString(peer)}
      </span>
    </div>
  )
}

export function PeersTab({ task }: { task: DownloadTask }) {
  const { t, i18n } = useTranslation()
  const { peers } = useTaskPeers(task.id, PEER_LIVE_STATUSES.has(task.status))
  const { status: geoStatus } = useGeoIPStatus()
  const showCountry = geoStatus?.enabled === true

  // Stable order: by downSpeed desc, then upSpeed desc, then ip — keeps
  // the most useful peers at the top and avoids list churn between
  // polls when speeds are 0.
  const sorted = useMemo(() => {
    return [...peers].sort((a, b) => {
      if (a.downSpeed !== b.downSpeed) return b.downSpeed - a.downSpeed
      if (a.upSpeed !== b.upSpeed) return b.upSpeed - a.upSpeed
      return a.ip.localeCompare(b.ip)
    })
  }, [peers])

  const summary = useMemo(() => {
    const totalDown = peers.reduce((s, p) => s + p.downSpeed, 0)
    const totalUp = peers.reduce((s, p) => s + p.upSpeed, 0)
    const seeders = peers.filter((p) => p.seeder).length
    return { totalDown, totalUp, seeders, count: peers.length }
  }, [peers])

  return (
    <div className="flex min-h-[105px] flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('panel.downloads.inspector.peers.summary', {
            count: summary.count,
            seeders: summary.seeders,
          })}
        </span>
        <span className="font-mono tabular-nums">
          ↓ {formatBytes(summary.totalDown)}/s · ↑{' '}
          {formatBytes(summary.totalUp)}/s
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border">
        <div
          className={cn(
            'sticky top-0 z-10 grid shrink-0',
            showCountry ? GRID_COLS_WITH_GEO : GRID_COLS_BASE,
            'items-center gap-3 border-b border-border bg-background rounded-t-md',
            'px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground'
          )}
        >
          {showCountry && (
            <>
              <span aria-hidden="true" />
              <span>{t('panel.downloads.inspector.peers.col.country')}</span>
            </>
          )}
          <span>{t('panel.downloads.inspector.peers.col.endpoint')}</span>
          <span>{t('panel.downloads.inspector.peers.col.client')}</span>
          <span className="text-right">
            {t('panel.downloads.inspector.peers.col.down')}
          </span>
          <span className="text-right">
            {t('panel.downloads.inspector.peers.col.up')}
          </span>
          <span className="text-right">
            {t('panel.downloads.inspector.peers.col.progress')}
          </span>
          <span
            className="text-right"
            title={t('panel.downloads.inspector.peers.col.flagsHint')}
          >
            {t('panel.downloads.inspector.peers.col.flags')}
          </span>
        </div>
        {sorted.length === 0 ? (
          <p className="p-3 text-center text-sm text-muted-foreground">
            {t('panel.downloads.inspector.peers.empty')}
          </p>
        ) : (
          <VirtualList<TaskPeer>
            items={sorted}
            getId={(p) => p.id}
            rowHeight={ROW_HEIGHT}
            className="max-h-[200px]"
            renderRow={({ item }) => (
              <PeerRow
                peer={item}
                locale={i18n.language}
                showCountry={showCountry}
              />
            )}
          />
        )}
      </div>
    </div>
  )
}
