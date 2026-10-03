import { DirectoryPicker } from '@renderer/components/desktop-kit/directory-picker'
import {
  DiskIcon,
  HttpIcon,
  MagnetIcon,
  MetalinkIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { useLiquidGlass } from '@renderer/hooks/use-liquid-glass'
import { useSidebarColor } from '@renderer/hooks/use-sidebar-color'
import { useTaskPieces } from '@renderer/hooks/use-task-pieces'
import { formatDurationHMS } from '@renderer/lib/format'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  type DownloadConfirmRequest,
  downloadConfirmRequestSchema,
} from '@shared/schemas/download-confirm'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { canOpenTaskFile } from '@shared/types/task-actions'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { WindowChrome } from '../components/window-chrome/window-chrome'

interface ConfirmFormValues {
  saveDir: string
  filename: string
  /** Engine split, as editable text (parsed on submit). */
  connections: string
  /** Per-task cap in KiB/s, as editable text (parsed on submit). */
  speedKiBs: string
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'confirm'; request: DownloadConfirmRequest }
  | { kind: 'progress'; taskId: string }

const KIND_ICONS = {
  url: HttpIcon,
  magnet: MagnetIcon,
  torrent: TorrentFileIcon,
} as const

const TYPE_ICONS: Record<string, typeof HttpIcon> = {
  http: HttpIcon,
  ftp: HttpIcon,
  magnet: MagnetIcon,
  bt: TorrentFileIcon,
  metalink: MetalinkIcon,
}

const STATUS_LABEL_KEYS: Partial<Record<TaskStatus, string>> = {
  [TaskStatus.Queued]: 'queued',
  [TaskStatus.FetchingMetadata]: 'fetchingMetadata',
  [TaskStatus.MetadataReady]: 'metadataReady',
  [TaskStatus.Downloading]: 'downloading',
  [TaskStatus.Finalizing]: 'finalizing',
  [TaskStatus.Paused]: 'paused',
  [TaskStatus.Completed]: 'completed',
  [TaskStatus.Error]: 'error',
  [TaskStatus.Seeding]: 'seeding',
}

/**
 * IDM-style window for downloads handed over by the browser bridge. Main owns
 * the pending request (queue + lifecycle; no timeout — closing the window
 * declines); the window renders two views: the confirmation form, then —
 * once main reports the created taskId — the progress dashboard. Glass tint
 * and accent hue follow the main app's appearance settings.
 */
export function DownloadConfirmWindow() {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [task, setTask] = useState<DownloadTask | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const form = useForm<ConfirmFormValues>({
    defaultValues: {
      saveDir: '',
      filename: '',
      connections: '',
      speedKiBs: '',
    },
  })
  const saveDir = form.watch('saveDir')
  const compact = viewport < 780
  // The window is resizable; track its width to switch between the stacked
  // (narrow) and side-by-side (wide) progress layouts.
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Mirror the main app's appearance settings onto this window: the hook
  // writes data-sidebar-color / --sidebar-hue (theme hue) on the root.
  useSidebarColor()
  const liquidGlass = useLiquidGlass()
  useEffect(() => {
    const root = document.documentElement
    if (liquidGlass) root.dataset.liquidGlass = 'true'
    else delete root.dataset.liquidGlass
    return () => {
      delete root.dataset.liquidGlass
    }
  }, [liquidGlass])

  useIpcEvent(Events.DownloadConfirmRequested, (payload: unknown) => {
    const parsed = downloadConfirmRequestSchema.safeParse(payload)
    if (!parsed.success) return
    setPhase({ kind: 'confirm', request: parsed.data })
    form.reset({
      saveDir: parsed.data.saveDir,
      filename: parsed.data.filename ?? '',
      connections: parsed.data.connections
        ? String(parsed.data.connections)
        : '',
      speedKiBs: parsed.data.dlLimit
        ? String(Math.round(parsed.data.dlLimit / 1024))
        : '',
    })
    setBusy(false)
  })

  useIpcEvent(Events.DownloadProgressAttached, (payload: unknown) => {
    const taskId =
      typeof payload === 'object' && payload !== null && 'taskId' in payload
        ? String((payload as { taskId: unknown }).taskId)
        : ''
    if (!taskId) return
    setTask(null)
    setPhase({ kind: 'progress', taskId })
  })

  useIpcEvent(Events.TaskUpdated, (snapshot: unknown) => {
    if (phase.kind !== 'progress' || !Array.isArray(snapshot)) return
    const match = (snapshot as DownloadTask[]).find(
      (candidate) => candidate.id === phase.taskId
    )
    setTask(match ?? null)
  })

  const respond = async (action: 'accept' | 'cancel') => {
    if (phase.kind !== 'confirm' || busy) return
    if (action === 'accept' && saveDir.trim().length === 0) return
    setBusy(true)
    try {
      if (action === 'accept') {
        const filename = form.getValues('filename').trim()
        const connectionsText = form.getValues('connections').trim()
        const speedText = form.getValues('speedKiBs').trim()
        const connections = Number.parseInt(connectionsText, 10)
        const speedKiBs = Number.parseFloat(speedText)
        await transport.invoke(Commands.ResolveDownloadConfirm, {
          requestId: phase.request.requestId,
          action: 'accept',
          saveDir: form.getValues('saveDir').trim(),
          ...(phase.request.kind === 'url' && filename ? { filename } : {}),
          ...(phase.request.kind === 'url' &&
          Number.isFinite(connections) &&
          connections >= 1
            ? { connections: Math.min(connections, 128) }
            : {}),
          ...(phase.request.kind === 'url' &&
          Number.isFinite(speedKiBs) &&
          speedKiBs > 0
            ? { dlLimit: Math.round(speedKiBs * 1024) }
            : {}),
        })
        // Main keeps the window open and reports the taskId through
        // DownloadProgressAttached; only a transport failure leaves the
        // confirm view interactive for a retry.
        setBusy(false)
      } else {
        await transport.invoke(Commands.ResolveDownloadConfirm, {
          requestId: phase.request.requestId,
          action: 'cancel',
        })
        // Main closes the window on cancel.
      }
    } catch {
      setBusy(false)
    }
  }

  const close = () => {
    void transport.invoke(Commands.CloseCurrentWindow)
  }

  const title =
    phase.kind === 'progress'
      ? t('downloadConfirm.progressTitle')
      : t('downloadConfirm.title')

  return (
    <div className="relative flex h-screen flex-col overflow-hidden">
      {liquidGlass && <div aria-hidden className="glass-ambient -z-10" />}
      <WindowChrome
        variant="titled"
        compact
        maximizable={false}
        title={title}
      />
      <PlatformServicesProvider services={electronServices}>
        {phase.kind === 'progress' ? (
          <ProgressView task={task} compact={compact} onClose={close} />
        ) : phase.kind === 'confirm' ? (
          <ConfirmView
            request={phase.request}
            busy={busy}
            canAccept={saveDir.trim().length > 0}
            respond={respond}
            form={form}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t('common.loading')}
          </div>
        )}
      </PlatformServicesProvider>
    </div>
  )
}

function ConfirmView({
  request,
  busy,
  canAccept,
  respond,
  form,
}: {
  request: DownloadConfirmRequest
  busy: boolean
  canAccept: boolean
  respond: (action: 'accept' | 'cancel') => Promise<void>
  form: ReturnType<typeof useForm<ConfirmFormValues>>
}) {
  const { t } = useTranslation()
  const KindIcon = KIND_ICONS[request.kind]
  const displayName =
    request.displayName ??
    (request.kind === 'torrent' ? t('downloadConfirm.torrentFile') : undefined)

  return (
    <FormProvider {...form}>
      <form
        className="flex min-h-0 flex-1 flex-col gap-4 px-6 pt-4 pb-5"
        onSubmit={form.handleSubmit(() => respond('accept'))}
      >
        <div className="glass-card flex items-start gap-3 rounded-2xl p-3.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/80 text-muted-foreground shadow-xs ring-1 ring-border/40">
            <KindIcon aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            {request.kind === 'url' ? (
              <Input
                {...form.register('filename')}
                dir="auto"
                aria-label={t('downloadConfirm.fileName')}
                placeholder={t('downloadConfirm.fileNameAuto')}
                className="h-8 text-sm font-medium"
                autoFocus
                onFocus={(event) => event.target.select()}
              />
            ) : (
              <div
                dir="auto"
                className="truncate pt-1.5 text-sm font-medium"
                title={displayName}
              >
                {displayName}
              </div>
            )}
            {request.uri && request.uri !== displayName && (
              <div
                dir="ltr"
                className="truncate font-mono text-xs text-muted-foreground"
                title={request.uri}
              >
                {request.uri}
              </div>
            )}
          </div>
        </div>
        <DirectoryPicker
          name="saveDir"
          variant="compact"
          showHistory
          recordRecent={false}
          prefixLabel={t('downloadConfirm.saveTo')}
          placeholder={t('task.add.saveDirEmpty')}
        />
        {request.kind === 'url' && (
          <div className="glass-card space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {t('downloadConfirm.transferOptions')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('downloadConfirm.thisTaskOnly')}
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {t('downloadConfirm.speedLimit')}
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    {...form.register('speedKiBs')}
                    type="number"
                    min={0}
                    inputMode="decimal"
                    aria-label={t('downloadConfirm.speedLimit')}
                    placeholder={t('task.add.unlimited')}
                    className="h-8 w-28 text-sm tabular-nums"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t('downloadConfirm.kibPerSecond')}
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {t('downloadConfirm.connections')}
                </span>
                <Input
                  {...form.register('connections')}
                  type="number"
                  min={1}
                  max={128}
                  inputMode="numeric"
                  aria-label={t('downloadConfirm.connections')}
                  placeholder={t('downloadConfirm.auto')}
                  className="h-8 w-28 text-sm tabular-nums"
                />
              </div>
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-end gap-2.5 border-t border-border/60 pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void respond('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !canAccept}>
            {t('common.download')}
          </Button>
        </div>
      </form>
    </FormProvider>
  )
}

function statusPillClass(status: TaskStatus): string {
  if (status === TaskStatus.Completed) return 'bg-emerald-500'
  if (status === TaskStatus.Error) return 'bg-destructive'
  if (status === TaskStatus.Downloading) return 'animate-pulse bg-primary'
  if (status === TaskStatus.Paused) return 'bg-amber-400'
  return 'bg-muted-foreground'
}

function ProgressView({
  task,
  compact,
  onClose,
}: {
  task: DownloadTask | null
  compact: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { formatBytes, formatSpeed } = useByteFormat()
  const taskId = task?.id ?? null
  const { pieces } = useTaskPieces(
    taskId,
    task?.status === TaskStatus.Downloading
  )
  const finished = task?.status === TaskStatus.Completed
  const failed = task?.status === TaskStatus.Error
  const settled = finished || failed
  const paused = task?.status === TaskStatus.Paused
  const TypeIcon = task ? (TYPE_ICONS[task.type] ?? HttpIcon) : null
  const percent = task ? Math.min(Math.max(task.progress, 0), 1) * 100 : 0
  const statusKey = task ? STATUS_LABEL_KEYS[task.status] : undefined
  const statusLabel =
    failed && task?.errorMessage
      ? task.errorMessage
      : statusKey
        ? t(`panel.downloads.status.${statusKey}`)
        : t('common.loading')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-3 pb-5">
      <div className="flex items-center justify-end">
        {task && statusKey && (
          <span className="flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs text-foreground/90">
            <span
              className={cn(
                'size-2 rounded-full',
                statusPillClass(task.status)
              )}
            />
            {statusLabel}
          </span>
        )}
      </div>
      <div className={cn('flex min-h-0 flex-1 gap-3', compact && 'flex-col')}>
        {/* Left card — identity, percent, size, linear bar */}
        <div className="glass-card flex min-w-0 flex-1 flex-col justify-between rounded-2xl p-4">
          <div className="flex items-center gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/80 text-muted-foreground shadow-xs ring-1 ring-border/40">
              {TypeIcon && <TypeIcon className="size-6" aria-hidden />}
            </div>
            <div className="min-w-0 flex-1">
              <div
                dir="auto"
                className="truncate text-base font-semibold"
                title={task?.name}
              >
                {task?.name ?? t('common.loading')}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {statusLabel}
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div
              className={cn(
                'text-5xl leading-none font-bold tracking-tight tabular-nums',
                failed && 'text-destructive'
              )}
            >
              {percent.toFixed(1)}
              <span className="ml-1 align-baseline text-lg font-normal text-muted-foreground">
                %
              </span>
            </div>
            {task && pieces && pieces.numPieces > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <DiskIcon className="size-4" aria-hidden />
                <span dir="ltr">
                  {pieces.numPieces} × {formatBytes(pieces.pieceLength)}
                </span>
              </div>
            )}
            {task && !settled && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {t('units.perSecond', {
                    value: formatSpeed(task.downloadSpeed),
                  })}
                </span>
                {task.etaSeconds > 0 && (
                  <span dir="ltr">{formatDurationHMS(task.etaSeconds)}</span>
                )}
              </div>
            )}
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted/70"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div
              className={cn(
                'h-full rounded-full bg-gradient-to-r from-primary/70 via-primary to-primary transition-[width] duration-700 ease-out',
                failed && 'from-destructive/70 via-destructive to-destructive'
              )}
              style={{
                width: `${failed ? 100 : Math.max(percent, percent > 0 ? 2 : 0)}%`,
              }}
            />
          </div>
        </div>
        {/* Right card — ring progress + full piece map */}
        <div
          className={cn(
            'glass-card flex shrink-0 flex-col rounded-2xl p-4',
            compact ? 'w-auto' : 'w-[240px]'
          )}
        >
          <div className="flex justify-center py-1">
            <RingProgress percent={failed ? 100 : percent} failed={failed} />
          </div>
          <div
            className={cn(
              'mt-auto flex min-h-0 flex-1 flex-col pt-3',
              compact && 'hidden'
            )}
          >
            <PieceGridCanvas
              bitfield={pieces?.bitfield ?? ''}
              numPieces={pieces?.numPieces ?? 0}
              failed={failed}
            />
            <div className="pt-2 text-center text-sm text-foreground/85">
              {t('panel.downloads.inspector.pieces.mapLabel')}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2.5">
        {task && !settled && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void transport.invoke(
                paused ? Commands.ResumeTask : Commands.PauseTask,
                task.id
              )
            }
          >
            {paused
              ? t('panel.downloads.action.resume')
              : t('panel.downloads.action.pause')}
          </Button>
        )}
        {settled && task && canOpenTaskFile(task) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void transport.invoke(Commands.OpenTaskFile, {
                taskId: task.id,
              })
            }
          >
            {t('panel.downloads.action.openFile')}
          </Button>
        )}
        {settled && task && (
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void transport.invoke(Commands.RevealInFolder, {
                taskId: task.id,
              })
            }
          >
            {t('panel.downloads.action.openFolder')}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </div>
  )
}

/** Donut ring matching the design mock; hue follows the theme accent. */
function RingProgress({
  percent,
  failed,
}: {
  percent: number
  failed: boolean
}) {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(Math.max(percent, 0), 100)
  return (
    <svg
      width="116"
      height="116"
      viewBox="0 0 116 116"
      className={cn('-rotate-90', failed && 'opacity-90')}
      role="img"
      aria-label={`${clamped.toFixed(1)}%`}
    >
      <defs>
        <linearGradient id="download-confirm-ring" x1="0" y1="0" x2="1" y2="1">
          <stop
            offset="0%"
            style={{ stopColor: 'hsl(var(--sidebar-hue, 186) 72% 52%)' }}
          />
          <stop
            offset="100%"
            style={{
              stopColor: 'hsl(calc(var(--sidebar-hue, 186) + 84) 68% 62%)',
            }}
          />
        </linearGradient>
      </defs>
      <circle
        cx="58"
        cy="58"
        r={radius}
        fill="none"
        strokeWidth="8"
        stroke="var(--muted)"
        opacity={0.55}
      />
      <circle
        cx="58"
        cy="58"
        r={radius}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        stroke={failed ? 'var(--destructive)' : 'url(#download-confirm-ring)'}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        className="transition-[stroke-dashoffset] duration-700 ease-out drop-shadow-[0_0_6px_rgb(0_0_0/0.15)]"
      />
    </svg>
  )
}

/**
 * The FULL piece map — one adaptive cell per piece, no downsampling — drawn
 * on canvas. Done cells take a diagonal hue sweep built on the theme accent;
 * pending cells stay dark, mirroring the reference design.
 */
function PieceGridCanvas({
  bitfield,
  numPieces,
  failed,
}: {
  bitfield: string
  numPieces: number
  failed: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const cssWidth = wrap.clientWidth
    const cssHeight = wrap.clientHeight
    if (cssWidth <= 0 || cssHeight <= 0) return

    const dpr = window.devicePixelRatio || 1
    const GAP = 3
    const rootStyle = getComputedStyle(document.documentElement)
    const hueBase = Number.parseInt(
      rootStyle.getPropertyValue('--sidebar-hue').trim() || '186',
      10
    )
    const pendingColor =
      rootStyle.getPropertyValue('--muted').trim() || '#3f3f46'

    // Largest cell size (3..14) whose full grid still fits the card area.
    let cell = 14
    let cols = 1
    let rows = 1
    for (; cell >= 3; cell--) {
      cols = Math.max(1, Math.floor((cssWidth + GAP) / (cell + GAP)))
      rows = Math.ceil(numPieces / cols)
      if (rows * (cell + GAP) - GAP <= cssHeight) break
    }
    const stride = cell + GAP
    const gridH = Math.max(stride, rows * stride - GAP)

    if (
      canvas.width !== Math.round(cssWidth * dpr) ||
      canvas.height !== Math.round(gridH * dpr)
    ) {
      canvas.width = Math.round(cssWidth * dpr)
      canvas.height = Math.round(gridH * dpr)
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${gridH}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, gridH)

    for (let i = 0; i < numPieces; i++) {
      const col = i % cols
      const row = (i / cols) | 0
      const x = col * stride
      const y = row * stride
      const hex = bitfield[i >> 2]
      let done = false
      if (hex) {
        const nibble = Number.parseInt(hex, 16)
        done = Boolean((nibble >> (3 - (i & 3))) & 1)
      }
      if (!done) {
        ctx.fillStyle = pendingColor
      } else if (failed) {
        ctx.fillStyle = 'hsl(0 72% 58%)'
      } else {
        // Diagonal sweep teal → violet → pink, echoing the reference art.
        const t = (col + row) / (cols + rows)
        const hue = hueBase + 96 * t
        const light = 54 + ((i % 3) - 1) * 5
        ctx.fillStyle = `hsl(${hue} 72% ${light}%)`
      }
      ctx.beginPath()
      ctx.roundRect(x, y, cell, cell, Math.min(2.5, cell / 3))
      ctx.fill()
    }
  }, [bitfield, numPieces, failed])

  return (
    <div ref={wrapRef} className="min-h-0 w-full flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="mx-auto block" />
    </div>
  )
}
