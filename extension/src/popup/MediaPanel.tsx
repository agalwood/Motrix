import {
  Check,
  Download,
  File,
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  Minus,
  RefreshCw,
  Send,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import { ImageQuickFilterPopover } from '@/popup/ImageQuickFilterPopover'
import { loadImagePreview } from '@/popup/imagePreview'
import {
  availableImageFormats,
  countActiveImageQuickFilters,
  type ImageQuickFilters,
  matchesImageQuickFilters,
} from '@/popup/imageQuickFilters'
import { usePageMedia } from '@/popup/usePageMedia'
import { supportsBackendConnections } from '@/shared/browserKind'
import { downloadErrorKey } from '@/shared/downloadErrorCopy'
import type { PairingState } from '@/shared/integration'
import {
  type DetectedMedia,
  mediaCategory,
  mediaStorageKey,
  readableMediaMetadata,
} from '@/shared/media'

type ResourceFilter = 'all' | 'video' | 'audio' | 'image'
type SubmitState = 'idle' | 'sending' | 'sent'

const RESOURCE_FILTERS: readonly ResourceFilter[] = [
  'all',
  'video',
  'audio',
  'image',
]
const BATCH_CONCURRENCY = 4
const LOADED_IMAGE_EVIDENCE = new Set([
  'network',
  'current-src',
  'performance',
  'fetch',
  'xhr',
])

function hasLoadedImageEvidence(media: DetectedMedia): boolean {
  return (
    media.evidence?.some((evidence) =>
      LOADED_IMAGE_EVIDENCE.has(evidence.trim().toLowerCase())
    ) ?? false
  )
}

function filenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').filter(Boolean).at(-1)
    if (!filename) return null
    try {
      return decodeURIComponent(filename)
    } catch {
      return filename
    }
  } catch {
    return null
  }
}

function mediaName(media: DetectedMedia): string {
  return (
    media.suggestedFilename?.trim() ||
    filenameFromUrl(media.url) ||
    media.alt?.trim() ||
    media.pageTitle.trim() ||
    media.url
  )
}

function mediaHost(media: DetectedMedia): string {
  try {
    return new URL(media.url).host
  } catch {
    return media.url
  }
}

function resourceIcon(media: DetectedMedia): typeof File {
  switch (mediaCategory(media)) {
    case 'audio':
      return FileAudio
    case 'image':
      return ImageIcon
    case 'video':
      return FileVideo
    default:
      return File
  }
}

function isSvgMedia(media: DetectedMedia): boolean {
  const mimeType = media.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mimeType === 'image/svg+xml') return true
  if (/^data:image\/svg\+xml(?:[;,]|$)/i.test(media.url)) return true
  try {
    return /\.svgz?$/i.test(new URL(media.url).pathname)
  } catch {
    return /\.svgz?(?:[?#]|$)/i.test(media.url)
  }
}

function mediaDomKey(media: DetectedMedia): string {
  const key = mediaStorageKey(media)
  return key.includes('\u0000') ? `composite-${encodeURIComponent(key)}` : key
}

function ResourceMedia({
  media,
  enabled,
  getThumbnail,
}: {
  media: DetectedMedia
  enabled: boolean
  getThumbnail: (media: DetectedMedia) => Promise<string | null>
}): React.ReactElement {
  const containerRef = useRef<HTMLSpanElement>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [preview, setPreview] = useState<{
    url: string
    ownedObjectUrl: boolean
  } | null>(null)
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined'
  )
  const category = mediaCategory(media)
  const canSamplePage =
    enabled &&
    category === 'image' &&
    media.previewable !== false &&
    !isSvgMedia(media) &&
    !previewFailed
  // If the page canvas cannot sample a cross-origin image, allow only URLs
  // that were observed as actually loaded to use the bounded, credentialless
  // HTTPS fallback. Lazy/srcset/meta candidates remain passive.
  const canFetchPublicResource = canSamplePage && hasLoadedImageEvidence(media)
  const previewImage = canSamplePage && preview !== null
  const Icon = resourceIcon(media)

  useEffect(() => {
    if (!canSamplePage) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const element = containerRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setNearViewport(true)
        observer.disconnect()
      },
      { rootMargin: '160px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [canSamplePage])

  useEffect(() => {
    setPreview(null)
    if (!canSamplePage || !nearViewport) return
    const controller = new AbortController()
    let mounted = true
    let objectUrl: string | null = null
    void (async () => {
      try {
        let pageThumbnail: string | null = null
        try {
          pageThumbnail = await getThumbnail(media)
        } catch {
          // Older builds or restricted frames may not expose the page sampler;
          // a network-backed public resource can still use the safe fallback.
        }
        if (!mounted || controller.signal.aborted) return
        if (
          typeof pageThumbnail === 'string' &&
          pageThumbnail.length <= 48 * 1024 &&
          /^data:image\/(?:webp|png|jpeg);base64,/i.test(pageThumbnail)
        ) {
          setPreview({ url: pageThumbnail, ownedObjectUrl: false })
          return
        }

        if (!canFetchPublicResource) return
        const loadedUrl = await loadImagePreview(media.url, {
          signal: controller.signal,
          width: 72,
          height: 72,
        })
        objectUrl = loadedUrl
        if (!mounted || controller.signal.aborted) {
          URL.revokeObjectURL(loadedUrl)
          objectUrl = null
          return
        }
        setPreview({ url: loadedUrl, ownedObjectUrl: true })
      } catch (error) {
        if (!mounted || (error as { name?: string }).name === 'AbortError') {
          return
        }
        setPreviewFailed(true)
      }
    })()
    return () => {
      mounted = false
      controller.abort()
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
    }
  }, [canFetchPublicResource, canSamplePage, getThumbnail, media, nearViewport])

  return (
    <span
      ref={containerRef}
      data-testid={`resource-thumbnail-${mediaDomKey(media)}`}
      data-preview={previewImage ? 'image' : 'fallback'}
      data-preview-source={
        preview ? (preview.ownedObjectUrl ? 'network' : 'page') : 'none'
      }
      className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-speed-download/[0.07] text-speed-download"
    >
      {previewImage ? (
        <img
          src={preview.url}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="size-11 object-cover"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <Icon className="size-4" aria-hidden="true" />
      )}
    </span>
  )
}

function positiveMetric(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : 0
}

function visibleResources(
  media: DetectedMedia[],
  filter: ResourceFilter
): DetectedMedia[] {
  const decorated = media.map((item, index) => ({ item, index }))
  const filtered =
    filter === 'all'
      ? decorated
      : decorated.filter(({ item }) => mediaCategory(item) === filter)

  if (filter === 'image') {
    filtered.sort((left, right) => {
      const leftArea =
        positiveMetric(left.item.width) * positiveMetric(left.item.height)
      const rightArea =
        positiveMetric(right.item.width) * positiveMetric(right.item.height)
      return (
        rightArea - leftArea ||
        positiveMetric(right.item.sizeBytes) -
          positiveMetric(left.item.sizeBytes) ||
        positiveMetric(right.item.detectedAt) -
          positiveMetric(left.item.detectedAt) ||
        left.index - right.index
      )
    })
  } else if (filter === 'all') {
    const priority = { video: 0, audio: 1, image: 2 } as const
    filtered.sort(
      (left, right) =>
        priority[mediaCategory(left.item)] -
          priority[mediaCategory(right.item)] || left.index - right.index
    )
  }

  return filtered.map(({ item }) => item)
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled,
  label,
  describedBy,
  onChange,
  compact = false,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  describedBy?: string
  onChange: () => void
  compact?: boolean
}): React.ReactElement {
  return (
    <label
      className={cn(
        'relative flex shrink-0 cursor-pointer items-center justify-center rounded-md outline-none has-focus-visible:ring-2 has-focus-visible:ring-ring/50 has-disabled:cursor-default has-disabled:opacity-50',
        compact ? 'size-6' : 'size-7'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        ref={(element) => {
          if (element) element.indeterminate = indeterminate
        }}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={onChange}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          'flex items-center justify-center border transition-colors',
          compact ? 'size-4 rounded-[4px]' : 'size-[18px] rounded-[5px]',
          checked || indeterminate
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-background text-transparent'
        )}
      >
        {indeterminate ? (
          <Minus
            className={compact ? 'size-2.5' : 'size-3'}
            strokeWidth={2.5}
          />
        ) : (
          <Check
            className={compact ? 'size-2.5' : 'size-3'}
            strokeWidth={2.5}
          />
        )}
      </span>
    </label>
  )
}

function ResourceRow({
  media,
  supported,
  canSubmit,
  pairIfNeeded,
  previewEnabled,
  selected,
  state,
  error,
  getThumbnail,
  onSelect,
  onDownload,
}: {
  media: DetectedMedia
  supported: boolean
  canSubmit: boolean
  pairIfNeeded: boolean
  previewEnabled: boolean
  selected: boolean
  state: SubmitState
  error: string | null
  getThumbnail: (media: DetectedMedia) => Promise<string | null>
  onSelect: () => void
  onDownload: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const disabledDescriptionId = useId()
  const hostDescriptionId = useId()
  const backendSupported = supportsBackendConnections()
  const name = mediaName(media)
  const host = mediaHost(media)
  const metadata = readableMediaMetadata(media)
  const unsupportedReason = t('popup.sniffer.unsupportedReason')
  const disabledReason = !canSubmit
    ? t('popup.integration.pairingUnavailable')
    : !supported
      ? unsupportedReason
      : null
  const disabledHint =
    canSubmit && !supported ? t('popup.sniffer.refreshCapabilitiesHint') : null
  const actionLabel = disabledReason
    ? t('popup.sniffer.unsupportedResource', {
        name,
        reason: disabledReason,
      })
    : pairIfNeeded
      ? `${t('contextMenu.pairThenDownload')}: ${name}`
      : supported
        ? state === 'sending'
          ? t('popup.sniffer.downloadingResource', { name })
          : state === 'sent'
            ? t('popup.sniffer.downloadedResource', { name })
            : t('popup.sniffer.quickDownloadResource', { name })
        : t('popup.sniffer.unsupportedResource', {
            name,
            reason: unsupportedReason,
          })
  const downloadButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        'me-3 size-8 shrink-0 rounded-lg text-muted-foreground',
        disabledReason
          ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground active:translate-y-0 dark:hover:bg-transparent'
          : 'hover:bg-speed-download/[0.1] hover:text-speed-download',
        state === 'sent' &&
          'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
      )}
      disabled={!supported || !canSubmit || state !== 'idle'}
      focusableWhenDisabled={!!disabledReason}
      title={disabledReason ? undefined : host}
      aria-label={actionLabel}
      aria-describedby={
        disabledReason ? disabledDescriptionId : hostDescriptionId
      }
      onClick={onDownload}
    >
      {state === 'sending' ? (
        <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
      ) : state === 'sent' ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
  return (
    <li
      data-testid={`resource-row-${mediaDomKey(media)}`}
      className="relative flex min-h-[68px] shrink-0 items-center py-2 transition-colors after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border last:after:hidden hover:bg-muted/40 focus-within:bg-muted/40"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 pe-1.5 ps-3">
        {backendSupported && (
          <SelectionCheckbox
            checked={selected}
            disabled={state === 'sending'}
            label={t('popup.sniffer.selectResource', { name })}
            describedBy={hostDescriptionId}
            onChange={onSelect}
          />
        )}
        <ResourceMedia
          media={media}
          enabled={previewEnabled}
          getThumbnail={getThumbnail}
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-xs font-medium"
            title={`${name} — ${host}`}
          >
            {name}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground">
            <span>{host}</span>
            {metadata && <span aria-hidden="true"> · </span>}
            {metadata && <span>{metadata}</span>}
          </span>
          {error && (
            <span
              role="alert"
              className="block whitespace-normal text-[11px] text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </span>
          )}
          <span id={hostDescriptionId} className="sr-only">
            {t('popup.sniffer.sourceHost', { host })}
          </span>
        </span>
      </div>
      {backendSupported &&
        (disabledReason ? (
          <Tooltip>
            <TooltipTrigger render={downloadButton} delay={300} />
            <TooltipContent
              role="tooltip"
              side="left"
              className="block max-w-[260px] leading-relaxed [overflow-wrap:anywhere]"
            >
              <p>{disabledReason}</p>
              {disabledHint && (
                <p className="mt-1 opacity-75">{disabledHint}</p>
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          downloadButton
        ))}
      {backendSupported && disabledReason && (
        <span id={disabledDescriptionId} className="sr-only">
          {disabledReason}
          {disabledHint && ` ${disabledHint}`}
        </span>
      )}
    </li>
  )
}

function ResolvablePageAction({
  site,
  canSubmit,
  pairIfNeeded,
  onResolve,
}: {
  site: 'bilibili' | 'youtube'
  canSubmit: boolean
  pairIfNeeded: boolean
  onResolve: () => Promise<{ taskId: string }>
}): React.ReactElement {
  const { t } = useTranslation()
  const disabledDescriptionId = useId()
  const [submitting, setSubmitting] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const discanSubmitReason = t('popup.integration.pairingUnavailable')

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setTaskId(null)
    setError(null)
    try {
      const result = await onResolve()
      setTaskId(result.taskId)
    } catch (error) {
      setError(t(downloadErrorKey(error)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-2 border-b border-border p-3">
      <Button
        type="button"
        size="xs"
        variant="secondary"
        disabled={!canSubmit || submitting || taskId !== null}
        title={!canSubmit ? discanSubmitReason : undefined}
        aria-describedby={!canSubmit ? disabledDescriptionId : undefined}
        onClick={() => void submit()}
      >
        {submitting ? (
          <Spinner data-icon="inline-start" />
        ) : taskId ? (
          <Check data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Send data-icon="inline-start" aria-hidden="true" />
        )}
        {t(
          pairIfNeeded
            ? 'contextMenu.pairThenDownload'
            : `popup.sniffer.pageAction.${site}`
        )}
      </Button>
      <span
        role={error ? 'alert' : 'status'}
        className={cn(
          'block w-full min-w-0 whitespace-normal text-xs [overflow-wrap:anywhere]',
          error ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {error ??
          (taskId ? t('popup.sniffer.pageSubmitted', { taskId }) : null)}
        {error === t('popup.sniffer.unsupportedSelectionReason') && (
          <span className="mt-1 block">
            {t('popup.sniffer.refreshCapabilitiesHint')}
          </span>
        )}
      </span>
      {!canSubmit && (
        <span id={disabledDescriptionId} className="sr-only">
          {discanSubmitReason}
        </span>
      )}
    </div>
  )
}

interface MediaPanelProps {
  active?: boolean
  connected?: boolean
  pairing?: PairingState
  submissionKey?: string
  onMediaCountChange?: (count: number) => void
}

export const MediaPanel = memo(function MediaPanel({
  active = false,
  connected = true,
  pairing = 'stored',
  submissionKey = 'default',
  onMediaCountChange,
}: MediaPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const backendSupported = supportsBackendConnections()
  const canAttemptSend =
    backendSupported && (pairing === 'stored' || pairing === 'none')
  const autoScanned = useRef(false)
  const submissionKeyRef = useRef(submissionKey)
  const capabilityRefreshPending = useRef(false)
  const inFlight = useRef(new Map<string, symbol>())
  const quickFilterAnchorRef = useRef<HTMLSpanElement>(null)
  const [filter, setFilter] = useState<ResourceFilter>('all')
  const [imageQuickFilters, setImageQuickFilters] = useState<ImageQuickFilters>(
    () => ({ formats: [] })
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [submitStates, setSubmitStates] = useState<Record<string, SubmitState>>(
    {}
  )
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({})
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const {
    media,
    selectionKinds,
    scanning,
    error,
    scan,
    download,
    getThumbnail,
    resolvableSite,
    resolvePageDownload,
  } = usePageMedia(submissionKey, pairing === 'none')

  useEffect(() => {
    if (submissionKeyRef.current !== submissionKey) {
      submissionKeyRef.current = submissionKey
      inFlight.current.clear()
      setSubmitStates({})
      setSubmitErrors({})
      if (autoScanned.current) capabilityRefreshPending.current = true
    }
    if (!autoScanned.current) {
      autoScanned.current = true
      capabilityRefreshPending.current = !connected
      void scan()
      return
    }
    if (!active) {
      if (!connected) capabilityRefreshPending.current = true
      return
    }
    if (!connected) {
      capabilityRefreshPending.current = true
      return
    }
    if (!capabilityRefreshPending.current) return
    // Refresh Backend capabilities after reconnecting without clearing the
    // resources or selection already discovered on the page.
    capabilityRefreshPending.current = false
    void scan()
  }, [active, connected, scan, submissionKey])

  useEffect(() => {
    onMediaCountChange?.(media.length)
  }, [media.length, onMediaCountChange])

  useEffect(() => {
    const currentKeys = new Set(media.map((item) => mediaStorageKey(item)))
    setSelected((current) => {
      const next = new Set([...current].filter((key) => currentKeys.has(key)))
      return next.size === current.size ? current : next
    })
    inFlight.current.forEach((_token, key) => {
      if (!currentKeys.has(key)) inFlight.current.delete(key)
    })
    setSubmitStates((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => currentKeys.has(key))
      )
    )
    setSubmitErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => currentKeys.has(key))
      )
    )
  }, [media])

  const allImageMedia = useMemo(
    () => media.filter((item) => mediaCategory(item) === 'image'),
    [media]
  )
  const availableFormats = useMemo(
    () => availableImageFormats(allImageMedia),
    [allImageMedia]
  )
  const activeImageFilterCount = countActiveImageQuickFilters(imageQuickFilters)
  const visibleMedia = useMemo(() => {
    const resources = visibleResources(media, filter)
    return filter === 'image'
      ? resources.filter((item) =>
          matchesImageQuickFilters(item, imageQuickFilters)
        )
      : resources
  }, [filter, imageQuickFilters, media])
  const selectableVisible = visibleMedia
  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((item) => selected.has(mediaStorageKey(item)))
  const someVisibleSelected = selectableVisible.some((item) =>
    selected.has(mediaStorageKey(item))
  )
  const selectedMedia = media.filter((item) =>
    selected.has(mediaStorageKey(item))
  )
  const selectedUnsupported = selectedMedia.some(
    (item) => connected && !selectionKinds.includes(item.kind)
  )

  const toggleSelected = (key: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAllVisible = (): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of selectableVisible) {
        const key = mediaStorageKey(item)
        if (allVisibleSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const submitOne = useCallback(
    async (item: DetectedMedia): Promise<boolean> => {
      if (!canAttemptSend) return false
      if (connected && !selectionKinds.includes(item.kind)) return false
      const key = mediaStorageKey(item)
      if (inFlight.current.has(key)) return false
      const requestToken = Symbol(key)
      inFlight.current.set(key, requestToken)
      setSubmitErrors((current) => ({ ...current, [key]: '' }))
      setSubmitStates((current) => ({
        ...current,
        [key]: 'sending',
      }))
      try {
        await download(item)
        if (inFlight.current.get(key) !== requestToken) return false
        setSubmitStates((current) => ({ ...current, [key]: 'sent' }))
        setSelected((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
        return true
      } catch (error) {
        if (inFlight.current.get(key) !== requestToken) return false
        setSubmitStates((current) => ({ ...current, [key]: 'idle' }))
        setSubmitErrors((current) => ({
          ...current,
          [key]: t(downloadErrorKey(error)),
        }))
        return false
      } finally {
        if (inFlight.current.get(key) === requestToken) {
          inFlight.current.delete(key)
        }
      }
    },
    [canAttemptSend, connected, download, selectionKinds, t]
  )

  const submitSelected = async (): Promise<void> => {
    if (
      batchSubmitting ||
      !canAttemptSend ||
      selectedUnsupported ||
      selectedMedia.length === 0
    ) {
      return
    }
    setBatchSubmitting(true)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < selectedMedia.length) {
        const item = selectedMedia[cursor]
        cursor += 1
        if (item) await submitOne(item)
      }
    }
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(BATCH_CONCURRENCY, selectedMedia.length) },
          worker
        )
      )
    } finally {
      setBatchSubmitting(false)
    }
  }

  const scanLabel = scanning
    ? t('popup.sniffer.scanning')
    : t('popup.sniffer.scan')
  const hasMedia = media.length > 0
  const controls = (
    <Tabs
      value={filter}
      onValueChange={(value) => setFilter(value as ResourceFilter)}
      className="block min-w-0"
    >
      <TabsList className="h-auto min-h-8 w-full min-w-0 flex-wrap items-stretch gap-0 rounded-[10px] bg-tab-background p-0.5 group-data-horizontal/tabs:h-auto">
        {RESOURCE_FILTERS.map((candidate) => (
          <TabsTrigger
            key={candidate}
            value={candidate}
            className="h-auto min-h-7 min-w-0 max-w-full flex-auto rounded-[8px] border-0 px-2 py-1 whitespace-normal text-[11px] [overflow-wrap:anywhere] font-normal shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-xs"
          >
            {t(`popup.sniffer.filters.${candidate}`)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
  const scanAction =
    error && !hasMedia ? undefined : (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="size-8 rounded-full"
        aria-label={scanLabel}
        title={scanLabel}
        disabled={scanning}
        onClick={() => void scan()}
      >
        {scanning ? <Spinner /> : <RefreshCw aria-hidden="true" />}
      </Button>
    )
  const batchDisabledReason = !canAttemptSend
    ? t('popup.integration.pairingUnavailable')
    : selectedUnsupported
      ? t('popup.sniffer.unsupportedSelectionReason')
      : null
  const batchDescriptionId = useId()
  const footerCount =
    filter === 'image' && activeImageFilterCount > 0
      ? t('popup.sniffer.filteredCount', {
          matched: visibleMedia.length,
          total: allImageMedia.length,
        })
      : filter === 'image'
        ? t('popup.sniffer.imageCount', { count: visibleMedia.length })
        : t('popup.sniffer.detected', { count: visibleMedia.length })

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <CompactSectionToolbar
        title={t('popup.sniffer.pageResources')}
        controls={controls}
        action={scanAction}
      />
      <CompactContentCard
        data-testid="media-panel-card"
        className="flex flex-col"
      >
        {backendSupported && resolvableSite && (
          <ResolvablePageAction
            key={submissionKey}
            site={resolvableSite}
            canSubmit={canAttemptSend}
            pairIfNeeded={pairing === 'none'}
            onResolve={resolvePageDownload}
          />
        )}
        {error && !hasMedia ? (
          <Empty className="min-h-0 flex-1 gap-2 overflow-y-auto p-3 [overflow-wrap:anywhere]">
            <EmptyHeader className="w-full min-w-0 gap-1">
              <EmptyTitle className="text-sm">
                {t('popup.sniffer.unavailableTitle')}
              </EmptyTitle>
              <EmptyDescription className="text-xs/normal">
                {t('popup.sniffer.unavailableDescription')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : scanning && !hasMedia ? (
          <Empty className="min-h-0 flex-1 gap-2 overflow-y-auto p-3 [overflow-wrap:anywhere]">
            <EmptyHeader className="w-full min-w-0 gap-1">
              <EmptyMedia>
                <Spinner className="size-5" />
              </EmptyMedia>
              <EmptyTitle className="text-sm">
                {t('popup.sniffer.scanning')}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : !hasMedia ? (
          <Empty className="min-h-0 flex-1 gap-2 overflow-y-auto p-3 [overflow-wrap:anywhere]">
            <EmptyHeader className="w-full min-w-0 gap-1">
              <EmptyTitle className="text-sm">
                {t('popup.sniffer.emptyTitle')}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1">
              {visibleMedia.length > 0 ? (
                <ul className="flex min-h-0 flex-col">
                  {visibleMedia.map((item) => (
                    <ResourceRow
                      key={mediaStorageKey(item)}
                      media={item}
                      supported={
                        !connected || selectionKinds.includes(item.kind)
                      }
                      canSubmit={canAttemptSend}
                      pairIfNeeded={pairing === 'none'}
                      previewEnabled={active}
                      selected={selected.has(mediaStorageKey(item))}
                      state={submitStates[mediaStorageKey(item)] ?? 'idle'}
                      error={submitErrors[mediaStorageKey(item)] || null}
                      getThumbnail={getThumbnail}
                      onSelect={() => toggleSelected(mediaStorageKey(item))}
                      onDownload={() => void submitOne(item)}
                    />
                  ))}
                </ul>
              ) : (
                <div className="flex min-h-full flex-col items-center justify-center gap-1.5 p-3 text-center text-xs [overflow-wrap:anywhere] text-muted-foreground">
                  <span>
                    {filter === 'image' && activeImageFilterCount > 0
                      ? t('popup.sniffer.noImageMatches')
                      : t('popup.sniffer.emptyFilter')}
                  </span>
                  {filter === 'image' && activeImageFilterCount > 0 && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setImageQuickFilters({ formats: [] })}
                    >
                      {t('popup.sniffer.clearFilters')}
                    </Button>
                  )}
                </div>
              )}
            </ScrollArea>
            <div
              data-testid="media-panel-footer"
              className="relative flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-2"
            >
              <span
                ref={quickFilterAnchorRef}
                aria-hidden="true"
                className="pointer-events-none absolute -top-px bottom-0 inset-x-[7px]"
              />
              {backendSupported && (
                <div className="flex min-h-7 min-w-0 max-w-full items-center gap-1 text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
                  <SelectionCheckbox
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected && !allVisibleSelected}
                    disabled={selectableVisible.length === 0}
                    label={t('popup.sniffer.selectAll')}
                    onChange={toggleAllVisible}
                    compact
                  />
                  {t('popup.sniffer.selectAll')}
                </div>
              )}
              {filter === 'image' && (
                <ImageQuickFilterPopover
                  filters={imageQuickFilters}
                  availableFormats={availableFormats}
                  matchedCount={visibleMedia.length}
                  totalCount={allImageMedia.length}
                  positionAnchor={quickFilterAnchorRef}
                  onChange={setImageQuickFilters}
                  onReset={() => setImageQuickFilters({ formats: [] })}
                />
              )}
              <span
                className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-muted-foreground"
                title={footerCount}
                aria-live="polite"
              >
                {footerCount}
              </span>
              {backendSupported && (
                <Button
                  type="button"
                  size="xs"
                  className="h-auto min-h-6 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                  aria-label={t(
                    pairing === 'none'
                      ? 'contextMenu.pairThenDownload'
                      : 'popup.sniffer.downloadSelected'
                  )}
                  disabled={
                    batchSubmitting ||
                    selectedMedia.length === 0 ||
                    batchDisabledReason !== null
                  }
                  title={batchDisabledReason ?? undefined}
                  aria-describedby={
                    batchDisabledReason ? batchDescriptionId : undefined
                  }
                  onClick={() => void submitSelected()}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  {pairing === 'none'
                    ? t('contextMenu.pairThenDownload')
                    : t('popup.sniffer.downloadCount', {
                        count: selected.size,
                      })}
                </Button>
              )}
              {backendSupported && batchDisabledReason && (
                <span id={batchDescriptionId} className="sr-only">
                  {batchDisabledReason}
                </span>
              )}
            </div>
          </>
        )}
      </CompactContentCard>
    </section>
  )
})
