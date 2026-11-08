import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
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
export const groupStyle =
  'gap-0 rounded-xl border-border/80 bg-card py-0 shadow-none'
const controlLabel = 'text-[13px] font-medium leading-[1.25rem]'

export function CreatorSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="min-w-0 space-y-1.5">
      <h2 className="ps-1 text-xs font-medium leading-5 text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

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
    <CreatorSection title={t('createTorrent.source')}>
      <Card className={cn(groupStyle, 'overflow-hidden')}>
        {source && (
          <>
            <div className="flex min-w-0 items-center gap-3 px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-chart-2/10 text-chart-2">
                <SourceIcon className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p
                  className="truncate text-[13px] font-semibold"
                  title={source.path}
                >
                  {source.path.split(/[/\\]/).at(-1)}
                </p>
                <p
                  dir="auto"
                  className="mt-0.5 truncate text-xs text-muted-foreground"
                  title={source.path}
                >
                  {source.path}
                </p>
              </div>
            </div>
            <Separator />
          </>
        )}
        <fieldset
          aria-label={t('createTorrent.source')}
          className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] items-stretch"
        >
          {(['file', 'directory'] as const).map((kind) => {
            const Icon = kind === 'file' ? DocumentIcon : FolderIcon
            return (
              <Button
                key={kind}
                type="button"
                variant="ghost"
                disabled={disabled}
                className={cn(
                  'relative min-w-0 justify-start gap-2.5 whitespace-normal rounded-none px-4 text-start text-[13px] font-medium leading-4 focus-visible:z-10 focus-visible:ring-inset',
                  source ? 'h-9' : 'h-14',
                  kind === 'directory' && 'col-start-3'
                )}
                onClick={() => onPick(kind)}
              >
                <span
                  className={cn(
                    'grid shrink-0 place-items-center',
                    source
                      ? 'text-muted-foreground'
                      : 'size-8 rounded-lg bg-chart-2/10 text-chart-2'
                  )}
                >
                  <Icon className={source ? 'size-4' : 'size-[17px]'} />
                </span>
                <span className="min-w-0">
                  {t(
                    kind === 'file'
                      ? 'directoryPicker.selectFile'
                      : 'directoryPicker.selectFolder'
                  )}
                </span>
                {!source && (
                  <ChevronRightIcon className="ms-auto size-3.5 shrink-0 text-muted-foreground/65 rtl:rotate-180" />
                )}
              </Button>
            )
          })}
          <Separator
            orientation="vertical"
            className="pointer-events-none col-start-2 row-start-1 my-2.5 h-auto! self-stretch"
          />
        </fieldset>
      </Card>
    </CreatorSection>
  )
}

export function ControlRow({
  id,
  label,
  children,
  top = false,
}: {
  id: string
  label: string
  children: ReactNode
  top?: boolean
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,6.75rem)_minmax(0,1fr)] gap-x-4 px-4 py-2.5',
        top ? 'items-start' : 'items-center'
      )}
    >
      <Label htmlFor={id} className={cn(controlLabel, top && 'pt-1.5')}>
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
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
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <Label htmlFor={id} className={controlLabel}>
          {label}
        </Label>
        {description && (
          <p
            id={`${id}-hint`}
            className="mt-0.5 text-xs leading-4 text-muted-foreground"
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
    <Card className={groupStyle}>
      <div className="flex min-w-0 items-center gap-3 px-4 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-chart-2/10 text-chart-2">
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
      <dl className="grid grid-cols-3 gap-4 px-4 py-3">
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
      <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
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
    </Card>
  )
}
