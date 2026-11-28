import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  DocumentIcon,
  FolderIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { cn } from '@renderer/lib/utils'
import type { CreateTorrentResultPayload } from '@shared/schemas/create-torrent'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export type SourceKind = 'file' | 'directory'
export interface PickedSource {
  path: string
  kind: SourceKind
}
const controlLabel = 'text-[13px] font-medium leading-5'
const fieldGrid = 'grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] gap-x-4'

export function SourcePicker({
  source,
  disabled,
  onPick,
}: {
  source: PickedSource | null
  disabled: boolean
  onPick: (kind: SourceKind) => void
}) {
  const { t } = useTranslation()
  const SourceIcon = source?.kind === 'directory' ? FolderIcon : DocumentIcon
  return (
    <section
      aria-labelledby="creator-source-label"
      className={cn(fieldGrid, 'items-start')}
    >
      <h2 id="creator-source-label" className={cn(controlLabel, 'pt-1.5')}>
        {t('createTorrent.source')}
      </h2>
      <div className="min-w-0">
        {source && (
          <div className="mb-2 flex min-w-0 items-center gap-2.5">
            <SourceIcon className="size-[18px] shrink-0 text-chart-2" />
            <div className="min-w-0">
              <p
                dir="auto"
                className="truncate text-[13px] font-medium leading-5"
                title={source.path}
              >
                {source.path.split(/[/\\]/).at(-1)}
              </p>
              <p
                dir="auto"
                className="truncate text-xs leading-4 text-muted-foreground"
                title={source.path}
              >
                {source.path}
              </p>
            </div>
          </div>
        )}
        <fieldset
          aria-labelledby="creator-source-label"
          className="flex min-w-0 flex-wrap gap-2"
        >
          {(['file', 'directory'] as const).map((kind) => {
            const Icon = kind === 'file' ? DocumentIcon : FolderIcon
            return (
              <Button
                type="button"
                key={kind}
                size="sm"
                variant="outline"
                disabled={disabled}
                className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-start text-[13px] font-medium shadow-none"
                onClick={() => onPick(kind)}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {t(
                  kind === 'file'
                    ? 'directoryPicker.selectFile'
                    : 'directoryPicker.selectFolder'
                )}
              </Button>
            )
          })}
        </fieldset>
      </div>
    </section>
  )
}

export function ControlRow({
  id,
  label,
  children,
  top = false,
  stretch = false,
}: {
  id: string
  label: string
  children: ReactNode
  top?: boolean
  stretch?: boolean
}) {
  return (
    <div
      className={cn(
        fieldGrid,
        'py-2',
        stretch ? 'flex-1 items-stretch' : top ? 'items-start' : 'items-center'
      )}
    >
      <Label
        htmlFor={id}
        className={cn(controlLabel, top && 'self-start pt-1.5')}
      >
        {label}
      </Label>
      <div className={cn('min-w-0', stretch && 'flex flex-col')}>
        {children}
      </div>
    </div>
  )
}

export function ToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div
        className={cn(
          'min-w-0 flex-1',
          description && fieldGrid,
          'items-baseline'
        )}
      >
        <Label htmlFor={id} className={controlLabel}>
          {label}
        </Label>
        {description && (
          <p
            id={`${id}-hint`}
            className="text-xs leading-4 text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        aria-describedby={description ? `${id}-hint` : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  )
}

export function TorrentSummary({
  result,
  children,
}: {
  result: CreateTorrentResultPayload
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const { formatBytes } = useByteFormat()
  const filename = `${result.name}.torrent`
  const copyLabel = `${t('menu.edit.copy')} · ${t('createTorrent.resultInfoHash')}`
  return (
    <section aria-label={filename} className="min-w-0">
      <div className="flex min-w-0 items-center gap-3 pb-3">
        <span className="grid size-8 shrink-0 place-items-center text-foreground">
          <TorrentFileIcon className="size-5" />
        </span>
        <h2
          className="min-w-0 truncate text-base font-semibold leading-5 tracking-tight"
          title={filename}
        >
          {filename}
        </h2>
      </div>
      <Separator />
      <dl className="grid grid-cols-3 gap-4 py-3">
        {[
          [t('createTorrent.resultSize'), formatBytes(result.totalSize)],
          [t('panel.downloads.inspector.tab.files'), result.fileCount],
          [t('panel.downloads.inspector.tab.pieces'), result.pieceCount],
        ].map(([name, value]) => (
          <div key={name} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="mt-1 text-[13px] font-medium tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <Separator />
      <div className="flex min-w-0 items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {t('createTorrent.resultInfoHash')}
          </p>
          <code
            dir="ltr"
            className="mt-1 block select-all break-all font-mono text-xs leading-4"
          >
            {result.infoHash}
          </code>
        </div>
        <CopyButton
          variant="ghost"
          size="icon-sm"
          content={result.infoHash}
          aria-label={copyLabel}
          title={copyLabel}
        />
      </div>
      {children && (
        <>
          <Separator />
          {children}
        </>
      )}
    </section>
  )
}
