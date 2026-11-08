import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  WarningIcon,
} from '@renderer/components/icons'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { useAdaptiveWindowHeight } from '@renderer/hooks/use-adaptive-window-height'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { windowChromeHeight } from '@shared/constants/window-chrome'
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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ControlRow,
  type PickedSource,
  type SourceKind,
  SourcePicker,
  ToggleRow,
  TorrentSummary,
} from './creator-sections'

const textField =
  'bg-background text-[13px] leading-5 placeholder:text-xs md:text-[13px]'
const listField = cn(
  textField,
  'field-sizing-fixed h-[3.25rem] min-h-0 resize-y py-1.5'
)
const pieceSizes = [32, 128, 512, 1024, 2048, 4096, 8192, 16384]
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
  const [source, setSource] = useState<PickedSource | null>(null)
  const [trackers, setTrackers] = useState('')
  const [webSeeds, setWebSeeds] = useState('')
  const [comment, setComment] = useState('')
  const [isPrivate, setPrivate] = useState(false)
  const [piece, setPiece] = useState('auto')
  const [seed, setSeed] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [invalidField, setInvalidField] = useState<
    'trackers' | 'webSeeds' | null
  >(null)
  const [status, setStatus] = useState<Status>('draft')
  const [result, setResult] = useState<CreateTorrentResultPayload | null>(null)
  const [saved, setSaved] = useState<ReturnType<
    typeof saveTorrentFileResultSchema.parse
  > | null>(null)
  const busy = useRef(false)
  useAdaptiveWindowHeight({
    minHeight: result ? 292 : 390,
    maxHeight: Math.min(700, window.screen.availHeight || 700),
    chromeHeight: windowChromeHeight(transport.platform, false) + 60,
  })
  useIpcEvent(Events.CreateTorrentProgress, (value) => {
    const p = createTorrentProgressSchema.safeParse(value)
    if (p.success) setProgress(Math.round(p.data * 100))
  })
  useEffect(() => {
    if (invalidField)
      document
        .getElementById(
          invalidField === 'webSeeds' ? 'creator-web-seeds' : 'creator-trackers'
        )
        ?.focus()
  }, [invalidField])
  const pick = async (kind: SourceKind) => {
    if (busy.current || status !== 'draft') return
    busy.current = true
    setStatus('picking')
    setError('')
    try {
      const selected = pickedTorrentSourceSchema
        .nullable()
        .parse(await transport.invoke(Commands.PickTorrentSource, kind))
      if (selected) setSource({ path: selected.path, kind })
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
      const field = parsed.error.issues[0]?.path[0]
      if (field === 'webSeeds') setAdvanced(true)
      setInvalidField(
        field === 'webSeeds' || field === 'trackers' ? field : null
      )
      setError(
        t('createTorrent.invalidOptions', { limit: CREATE_TORRENT_URL_LIMIT })
      )
      return
    }
    busy.current = true
    setInvalidField(null)
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
  const seedOption = (
    <ToggleRow
      id="seed"
      label={t('createTorrent.seedAfter')}
      checked={seed}
      disabled={status === 'saving'}
      onChange={setSeed}
    />
  )
  const pieceOptions = [
    { value: 'auto', label: t('createTorrent.pieceAuto') },
    ...pieceSizes.map((kib) => ({
      value: String(kib * 1024),
      label: formatBytes(kib * 1024),
    })),
  ]
  const clearValidation = () => {
    if (invalidField) {
      setInvalidField(null)
      setError('')
    }
  }
  const fieldError =
    invalidField && error ? (
      <p
        id="creator-error"
        role="alert"
        className="mt-1.5 text-xs leading-4 text-destructive"
      >
        {error}
      </p>
    ) : null
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <WindowChrome
        variant="titled"
        maximizable={false}
        title={t('createTorrent.title')}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-adaptive-content
          className="mx-auto w-full max-w-[42rem] space-y-3 px-6 pt-2 pb-4"
        >
          {!result ? (
            <>
              <SourcePicker
                source={source}
                disabled={locked}
                onPick={(kind) => void pick(kind)}
              />
              <section
                aria-label={t('createTorrent.options')}
                className="min-w-0"
              >
                <ControlRow
                  id="creator-trackers"
                  label={t('createTorrent.trackers')}
                  top
                >
                  <Textarea
                    id="creator-trackers"
                    spellCheck={false}
                    dir="ltr"
                    disabled={locked}
                    className={listField}
                    value={trackers}
                    aria-invalid={invalidField === 'trackers' || undefined}
                    aria-describedby={
                      invalidField === 'trackers' ? 'creator-error' : undefined
                    }
                    onChange={(e) => {
                      setTrackers(e.target.value)
                      clearValidation()
                    }}
                    placeholder={t('createTorrent.trackersPlaceholder')}
                  />
                  {invalidField === 'trackers' && fieldError}
                </ControlRow>
                <ToggleRow
                  id="private"
                  label={t('createTorrent.private')}
                  description={t('createTorrent.privateDesc')}
                  checked={isPrivate}
                  disabled={locked}
                  onChange={(value) => {
                    setPrivate(value)
                    clearValidation()
                  }}
                />
                {seedOption}
                <Separator className="my-2 bg-border/70" />
                <Collapsible open={advanced} onOpenChange={setAdvanced}>
                  <CollapsibleTrigger
                    disabled={locked}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ms-2 h-8 gap-1.5 px-2 has-[>svg]:px-2 text-xs text-muted-foreground hover:text-foreground"
                      />
                    }
                  >
                    <ChevronRightIcon
                      className={cn(
                        'size-3.5 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150',
                        advanced ? 'rotate-90' : 'rtl:rotate-180'
                      )}
                    />
                    {t('task.add.advanced')}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-1">
                    <ControlRow
                      id="creator-web-seeds"
                      label={t('createTorrent.webSeeds')}
                      top
                    >
                      <Textarea
                        id="creator-web-seeds"
                        dir="ltr"
                        spellCheck={false}
                        disabled={locked}
                        className={listField}
                        value={webSeeds}
                        aria-invalid={invalidField === 'webSeeds' || undefined}
                        aria-describedby={
                          invalidField === 'webSeeds'
                            ? 'creator-error'
                            : undefined
                        }
                        onChange={(e) => {
                          setWebSeeds(e.target.value)
                          clearValidation()
                        }}
                        placeholder={t('createTorrent.webSeedsPlaceholder')}
                      />
                      {invalidField === 'webSeeds' && fieldError}
                    </ControlRow>
                    <ControlRow
                      id="creator-comment"
                      label={t('createTorrent.comment')}
                    >
                      <Input
                        id="creator-comment"
                        className={cn(textField, 'h-8')}
                        value={comment}
                        disabled={locked}
                        maxLength={CREATE_TORRENT_COMMENT_MAX}
                        onChange={(e) => setComment(e.target.value)}
                      />
                    </ControlRow>
                    <ControlRow
                      id="creator-piece"
                      label={t('createTorrent.pieceLength')}
                    >
                      <Select
                        items={pieceOptions}
                        value={piece}
                        disabled={locked}
                        onValueChange={(value) => {
                          if (value !== null) setPiece(value)
                        }}
                      >
                        <SettingsSelectTrigger
                          id="creator-piece"
                          className="text-[13px]"
                        >
                          <SelectValue />
                        </SettingsSelectTrigger>
                        <SelectContent position="popper" align="start">
                          {pieceOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ControlRow>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            </>
          ) : (
            <TorrentSummary result={result}>
              {!saved && seedOption}
            </TorrentSummary>
          )}
          {status === 'hashing' && (
            <div className="space-y-1.5" role="status">
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
            <Alert role="status" className="border-border/80">
              {saved.seeding === 'failed' ? <WarningIcon /> : <CheckIcon />}
              <AlertDescription className="min-w-0 select-text break-words text-xs leading-5 text-foreground">
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
              </AlertDescription>
            </Alert>
          )}
          {error && !invalidField && (
            <Alert id="creator-error" variant="destructive">
              <WarningIcon />
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </main>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-background px-6 py-2.5">
        {status === 'ready' && (
          <Button
            size="sm"
            variant="ghost"
            className="me-auto text-[13px] text-muted-foreground"
            onClick={() => {
              setResult(null)
              setStatus('draft')
              setError('')
            }}
          >
            <ChevronLeftIcon className="size-3.5 rtl:rotate-180" />
            {t('menu.edit.title')}
          </Button>
        )}
        <Button
          size="sm"
          variant={saved ? 'default' : 'outline'}
          className="min-w-16 text-[13px]"
          disabled={status === 'saving'}
          onClick={() =>
            void transport.invoke(Commands.CloseCurrentWindow, {
              showMain: 'if-visible',
            })
          }
        >
          {t('common.close')}
        </Button>
        {!saved && (
          <Button
            size="sm"
            className="min-w-20 text-[13px]"
            disabled={result ? status !== 'ready' : !source || locked}
            onClick={() => void (result ? save() : create())}
          >
            {(status === 'saving' || status === 'hashing') && (
              <Spinner
                aria-hidden="true"
                className="size-3.5 motion-reduce:animate-none"
              />
            )}
            {t(result ? 'createTorrent.saveFile' : 'createTorrent.create')}
          </Button>
        )}
      </footer>
    </div>
  )
}
