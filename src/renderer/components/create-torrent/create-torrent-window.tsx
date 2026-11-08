import {
  ChevronRightIcon,
  FilesIcon,
  FolderIcon,
  TorrentFileIcon,
} from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { useAdaptiveWindowHeight } from '@renderer/hooks/use-adaptive-window-height'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  CREATE_TORRENT_COMMENT_MAX,
  CREATE_TORRENT_URL_LIMIT,
  type CreateTorrentResultPayload,
  createTorrentProgressSchema,
  createTorrentRequestSchema,
  createTorrentResultSchema,
  pickedTorrentSourceSchema,
  saveTorrentFileResultSchema,
} from '@shared/schemas/create-torrent'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
type Status = 'draft' | 'picking' | 'hashing' | 'ready' | 'saving' | 'done'
export function CreateTorrentWindow() {
  const { t } = useTranslation()
  const { formatBytes } = useByteFormat()
  const [advanced, setAdvanced] = useState(false)
  const [source, setSource] = useState('')
  const [trackers, setTrackers] = useState('')
  const [webSeeds, setWebSeeds] = useState('')
  const [comment, setComment] = useState('')
  const [isPrivate, setPrivate] = useState(false)
  const [piece, setPiece] = useState('auto')
  const [seed, setSeed] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<Status>('draft')
  const [result, setResult] = useState<CreateTorrentResultPayload | null>(null)
  const [saved, setSaved] = useState<ReturnType<
    typeof saveTorrentFileResultSchema.parse
  > | null>(null)
  const busy = useRef(false)
  useAdaptiveWindowHeight({
    minHeight: result ? 292 : 390,
    maxHeight: Math.min(700, window.screen.availHeight || 700),
    chromeHeight: 100,
  })
  useIpcEvent(Events.CreateTorrentProgress, (value) => {
    const p = createTorrentProgressSchema.safeParse(value)
    if (p.success) setProgress(Math.round(p.data * 100))
  })
  const pick = async (kind: 'file' | 'directory') => {
    if (busy.current || status !== 'draft') return
    busy.current = true
    setStatus('picking')
    setError('')
    try {
      const selected = pickedTorrentSourceSchema
        .nullable()
        .parse(await transport.invoke(Commands.PickTorrentSource, kind))
      if (selected) setSource(selected.path)
    } catch {
      setError(t('createTorrent.createFailed'))
    } finally {
      busy.current = false
      setStatus('draft')
    }
  }
  const create = async () => {
    if (busy.current || status !== 'draft' || !source) return
    const parsed = createTorrentRequestSchema.safeParse({
      trackers: lines(trackers),
      webSeeds: lines(webSeeds),
      comment: comment.trim() || undefined,
      private: isPrivate,
      pieceLength: piece === 'auto' ? undefined : Number(piece),
    })
    if (!parsed.success) {
      setError(
        t('createTorrent.invalidOptions', { limit: CREATE_TORRENT_URL_LIMIT })
      )
      return
    }
    busy.current = true
    setProgress(0)
    setStatus('hashing')
    setError('')
    try {
      setResult(
        createTorrentResultSchema.parse(
          await transport.invoke(Commands.CreateTorrent, parsed.data)
        )
      )
      setStatus('ready')
    } catch {
      setError(t('createTorrent.createFailed'))
      setStatus('draft')
    } finally {
      busy.current = false
    }
  }
  const save = async () => {
    if (busy.current || !result || status !== 'ready') return
    busy.current = true
    setStatus('saving')
    setError('')
    try {
      const value = saveTorrentFileResultSchema.nullable().parse(
        await transport.invoke(Commands.SaveTorrentFile, {
          id: result.id,
          seed,
        })
      )
      if (!value) {
        setStatus('ready')
        return
      }
      setSaved(value)
      setStatus('done')
    } catch {
      setError(t('createTorrent.saveFailed'))
      setStatus('ready')
    } finally {
      busy.current = false
    }
  }
  const locked = status !== 'draft'
  const filename = source.split(/[/\\]/).at(-1)
  const fieldClass =
    'h-8 bg-background text-[13px] leading-5 shadow-none placeholder:text-xs md:text-[13px]'
  const areaClass =
    'field-sizing-fixed min-h-0 h-[3.4rem] resize-y bg-background text-[13px] leading-5 shadow-none placeholder:text-xs md:text-[13px]'
  const labelClass = 'block text-xs font-medium leading-4'
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <WindowChrome
        variant="titled"
        compact
        maximizable={false}
        title={t('createTorrent.title')}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-adaptive-content
          className="mx-auto w-full max-w-[40rem] px-5 pb-5 pt-3 sm:px-6"
        >
          {!result ? (
            <fieldset disabled={locked} className="min-w-0 space-y-4">
              <section aria-labelledby="source-heading">
                <h2 id="source-heading" className={labelClass}>
                  {t('createTorrent.source')}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-3 rounded-lg border bg-muted/25 p-3">
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary"
                  >
                    <TorrentFileIcon className="size-[19px]" />
                  </span>
                  <div className="min-w-0 flex-1 basis-40">
                    <p
                      className={
                        source
                          ? 'truncate text-[13px] font-medium leading-5'
                          : 'truncate text-xs leading-5 text-muted-foreground'
                      }
                      title={source || undefined}
                    >
                      {filename || t('createTorrent.sourcePlaceholder')}
                    </p>
                    {source && (
                      <p
                        dir="auto"
                        className="truncate text-xs leading-4 text-muted-foreground"
                        title={source}
                      >
                        {source}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 bg-background px-2 text-xs shadow-none"
                      onClick={() => void pick('file')}
                    >
                      <FilesIcon className="size-3.5" />
                      {t('directoryPicker.selectFile')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 bg-background px-2 text-xs shadow-none"
                      onClick={() => void pick('directory')}
                    >
                      <FolderIcon className="size-3.5" />
                      {t('directoryPicker.selectFolder')}
                    </Button>
                  </div>
                </div>
              </section>
              <div className="space-y-1.5">
                <label htmlFor="creator-trackers" className={labelClass}>
                  {t('createTorrent.trackers')}
                </label>
                <Textarea
                  id="creator-trackers"
                  spellCheck={false}
                  dir="ltr"
                  className={areaClass}
                  value={trackers}
                  onChange={(e) => setTrackers(e.target.value)}
                  placeholder={t('createTorrent.trackersPlaceholder')}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label htmlFor="private" className={labelClass}>
                    {t('createTorrent.private')}
                  </label>
                  <p
                    id="private-description"
                    className="mt-0.5 text-xs leading-4 text-muted-foreground"
                  >
                    {t('createTorrent.privateDesc')}
                  </p>
                </div>
                <Switch
                  id="private"
                  aria-describedby="private-description"
                  checked={isPrivate}
                  disabled={locked}
                  onCheckedChange={setPrivate}
                />
              </div>
              <div className="border-t pt-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm py-1.5 text-start text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-ring"
                  aria-expanded={advanced}
                  aria-controls="creator-advanced"
                  onClick={() => setAdvanced(!advanced)}
                >
                  <ChevronRightIcon
                    className={
                      advanced
                        ? 'size-3.5 rotate-90'
                        : 'size-3.5 rtl:rotate-180'
                    }
                  />
                  {t('task.add.advanced')}
                </button>
                {advanced && (
                  <div id="creator-advanced" className="mt-2 grid gap-3.5 pb-1">
                    <div className="space-y-1.5">
                      <label htmlFor="creator-web-seeds" className={labelClass}>
                        {t('createTorrent.webSeeds')}
                      </label>
                      <Textarea
                        id="creator-web-seeds"
                        dir="ltr"
                        spellCheck={false}
                        className={areaClass}
                        value={webSeeds}
                        onChange={(e) => setWebSeeds(e.target.value)}
                        placeholder={t('createTorrent.webSeedsPlaceholder')}
                      />
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5">
                      <label htmlFor="creator-comment" className={labelClass}>
                        {t('createTorrent.comment')}
                      </label>
                      <label htmlFor="creator-piece" className={labelClass}>
                        {t('createTorrent.pieceLength')}
                      </label>
                      <Input
                        id="creator-comment"
                        className={fieldClass}
                        value={comment}
                        maxLength={CREATE_TORRENT_COMMENT_MAX}
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <select
                        id="creator-piece"
                        className="h-8 max-w-40 rounded-md border border-input bg-background px-2 text-xs"
                        value={piece}
                        onChange={(e) => setPiece(e.target.value)}
                      >
                        <option value="auto">
                          {t('createTorrent.pieceAuto')}
                        </option>
                        {[32, 128, 512, 1024, 2048, 4096, 8192, 16384].map(
                          (kib) => (
                            <option key={kib} value={kib * 1024}>
                              {formatBytes(kib * 1024)}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </fieldset>
          ) : (
            <section
              aria-label={t('createTorrent.resultName')}
              className="rounded-lg border bg-muted/20"
            >
              <div className="flex min-w-0 items-center gap-3 border-b p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
                  <TorrentFileIcon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h2
                    className="truncate text-sm font-semibold"
                    title={result.name}
                  >
                    {result.name}
                  </h2>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-3 border-b px-4 py-3">
                {[
                  [
                    t('createTorrent.resultSize'),
                    formatBytes(result.totalSize),
                  ],
                  [t('panel.downloads.inspector.tab.files'), result.fileCount],
                  [
                    t('panel.downloads.inspector.tab.pieces'),
                    result.pieceCount,
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs leading-4 text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="mt-1 text-[13px] font-medium tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="space-y-1 px-4 py-3">
                <p className={labelClass}>
                  {t('createTorrent.resultInfoHash')}
                </p>
                <code
                  dir="ltr"
                  className="block select-all break-all text-xs leading-5 text-muted-foreground"
                >
                  {result.infoHash}
                </code>
              </div>
            </section>
          )}
          {status === 'hashing' && (
            <div className="mt-4 space-y-1.5" role="status">
              <p className="flex justify-between text-xs text-muted-foreground">
                {t('createTorrent.hashing')}
                <span className="tabular-nums">{progress}%</span>
              </p>
              <Progress
                value={progress}
                aria-label={t('createTorrent.hashing')}
              />
            </div>
          )}
          {saved && (
            <div
              role="status"
              className="mt-3 space-y-1 select-text break-words rounded-md border px-3 py-2.5 text-xs leading-5"
            >
              <p>{t('createTorrent.savedToast', { path: saved.path })}</p>
              {saved.seeding !== 'not-requested' && (
                <p
                  className={
                    saved.seeding === 'failed'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }
                >
                  {t(
                    saved.seeding === 'failed'
                      ? 'createTorrent.seedFailed'
                      : 'createTorrent.seedSubmitted'
                  )}
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              {error}
            </p>
          )}
        </div>
      </main>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3 sm:px-6">
        {!saved && (
          <div className="me-auto flex min-w-0 flex-1 items-center gap-2">
            <Switch
              id="seed"
              className="shrink-0"
              disabled={status === 'saving'}
              checked={seed}
              onCheckedChange={setSeed}
            />
            <label htmlFor="seed" className="text-xs leading-4">
              {t('createTorrent.seedAfter')}
            </label>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 bg-background text-xs"
          disabled={status === 'saving'}
          onClick={() =>
            void transport.invoke(Commands.CloseCurrentWindow, {
              showMain: 'if-visible',
            })
          }
        >
          {t('common.close')}
        </Button>
        {status === 'ready' && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => {
              setResult(null)
              setStatus('draft')
              setError('')
            }}
          >
            {t('menu.edit.title')}
          </Button>
        )}
        {status !== 'done' && (
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={result ? status !== 'ready' : !source || locked}
            onClick={() => void (result ? save() : create())}
          >
            {t(result ? 'createTorrent.saveFile' : 'createTorrent.create')}
          </Button>
        )}
      </footer>
    </div>
  )
}
