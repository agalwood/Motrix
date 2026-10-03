import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import {
  type CreateTorrentProgressPayload,
  type CreateTorrentResultPayload,
  createTorrentRequestSchema,
  createTorrentUrlSchema,
} from '@shared/schemas/create-torrent'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCreateTorrentDialogStore } from './use-create-torrent-dialog-store'

const PIECE_LENGTH_CHOICES = [
  { value: 32 * 1024, label: '32 KiB' },
  { value: 128 * 1024, label: '128 KiB' },
  { value: 512 * 1024, label: '512 KiB' },
  { value: 1024 * 1024, label: '1 MiB' },
  { value: 2 * 1024 * 1024, label: '2 MiB' },
  { value: 4 * 1024 * 1024, label: '4 MiB' },
  { value: 8 * 1024 * 1024, label: '8 MiB' },
  { value: 16 * 1024 * 1024, label: '16 MiB' },
]

// Split a textarea value into URL tiers, one announce per line.
function parseUrlLines(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = []
  const invalid: string[] = []
  for (const line of text.split('\n')) {
    const candidate = line.trim()
    if (!candidate) continue
    if (createTorrentUrlSchema.safeParse(candidate).success)
      urls.push(candidate)
    else invalid.push(candidate)
  }
  return { urls, invalid }
}

export function CreateTorrentDialog() {
  const { t } = useTranslation()
  const { formatBytes } = useByteFormat()
  const open = useCreateTorrentDialogStore((s) => s.open)
  const close = useCreateTorrentDialogStore((s) => s.close)

  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [trackersText, setTrackersText] = useState('')
  const [webSeedsText, setWebSeedsText] = useState('')
  const [comment, setComment] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [pieceLength, setPieceLength] = useState<number | 'auto'>('auto')
  const [picking, setPicking] = useState(false)
  const [hashing, setHashing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<CreateTorrentResultPayload | null>(null)
  const [saving, setSaving] = useState(false)

  // Live piece-hashing progress. Only one create runs at a time (enforced
  // main-side), so no per-operation filtering is needed.
  useEffect(() => {
    if (!open || !hashing) return
    const onProgress = (...args: unknown[]) => {
      const payload = args[0] as CreateTorrentProgressPayload
      setProgress(Math.round(payload.fraction * 100))
    }
    transport.on(Events.CreateTorrentProgress, onProgress)
    return () => {
      transport.off(Events.CreateTorrentProgress, onProgress)
    }
  }, [open, hashing])

  const reset = () => {
    setSourcePath(null)
    setTrackersText('')
    setWebSeedsText('')
    setComment('')
    setIsPrivate(false)
    setPieceLength('auto')
    setHashing(false)
    setProgress(0)
    setResult(null)
  }

  const handleClose = () => {
    if (hashing || saving) return
    close()
    // Keep values if a result is present? Simplicity: reset on close.
    reset()
  }

  const pickSource = async () => {
    setPicking(true)
    try {
      const picked = (await transport.invoke(Commands.PickTorrentSource)) as {
        path: string
      } | null
      if (picked?.path) setSourcePath(picked.path)
    } finally {
      setPicking(false)
    }
  }

  const startCreate = async () => {
    if (!sourcePath || hashing || result) return
    const trackers = parseUrlLines(trackersText)
    const webSeeds = parseUrlLines(webSeedsText)
    if (trackers.invalid.length || webSeeds.invalid.length) {
      toast.add({
        title: t('createTorrent.invalidTracker'),
        type: 'error',
      })
      return
    }
    setHashing(true)
    setProgress(0)
    try {
      const parsed = createTorrentRequestSchema.parse({
        sourcePath,
        trackers: trackers.urls,
        webSeeds: webSeeds.urls,
        comment: comment.trim() || undefined,
        private: isPrivate,
        pieceLength: pieceLength === 'auto' ? undefined : pieceLength,
      })
      const created = (await transport.invoke(
        Commands.CreateTorrent,
        parsed
      )) as CreateTorrentResultPayload
      setResult(created)
    } catch {
      toast.add({ title: t('createTorrent.createFailed'), type: 'error' })
    } finally {
      setHashing(false)
    }
  }

  const saveFile = async () => {
    if (!result || saving) return
    setSaving(true)
    try {
      const saved = (await transport.invoke(Commands.SaveTorrentFile, {
        torrentBase64: result.torrentBase64,
        suggestedSaveName: result.suggestedSaveName,
      })) as { path: string } | null
      if (saved?.path) {
        toast.add({
          title: t('createTorrent.savedToast', { path: saved.path }),
          type: 'success',
        })
        close()
        reset()
      }
    } catch {
      toast.add({ title: t('createTorrent.saveFailed'), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const infoHashShown = result ? `${result.infoHash.slice(0, 16)}…` : null

  return (
    <Dialog
      open={open}
      onOpenChange={(v, details) => {
        if (!v && !hashing && !saving) {
          details.cancel()
          handleClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[560px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t('createTorrent.title')}</DialogTitle>
          <DialogDescription>
            {t('createTorrent.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('createTorrent.source')}</p>
            <div className="flex items-center gap-2">
              <Input
                value={sourcePath ?? ''}
                readOnly
                placeholder={t('createTorrent.sourcePlaceholder')}
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={picking || hashing}
                onClick={() => void pickSource()}
              >
                {t('createTorrent.browse')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('createTorrent.trackers')}</p>
            <Textarea
              value={trackersText}
              disabled={hashing}
              rows={3}
              placeholder={t('createTorrent.trackersPlaceholder')}
              className="font-mono text-xs"
              onChange={(e) => setTrackersText(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('createTorrent.webSeeds')}</p>
            <Textarea
              value={webSeedsText}
              disabled={hashing}
              rows={2}
              placeholder={t('createTorrent.webSeedsPlaceholder')}
              className="font-mono text-xs"
              onChange={(e) => setWebSeedsText(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('createTorrent.comment')}</p>
            <Input
              value={comment}
              disabled={hashing}
              maxLength={2048}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t('createTorrent.private')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('createTorrent.privateDesc')}
              </p>
            </div>
            <Switch
              checked={isPrivate}
              disabled={hashing}
              onCheckedChange={setIsPrivate}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium">
              {t('createTorrent.pieceLength')}
            </p>
            <select
              value={String(pieceLength)}
              disabled={hashing}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              onChange={(e) =>
                setPieceLength(
                  e.target.value === 'auto' ? 'auto' : Number(e.target.value)
                )
              }
            >
              <option value="auto">{t('createTorrent.pieceAuto')}</option>
              {PIECE_LENGTH_CHOICES.map((choice) => (
                <option key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          {hashing && (
            <div className="space-y-1">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {t('createTorrent.hashing')} {progress}%
              </p>
            </div>
          )}

          {result && (
            <div className="space-y-1 rounded-md border p-3 text-xs">
              <p>
                {t('createTorrent.resultName')}: {result.name}
              </p>
              <p>
                {t('createTorrent.resultSize')}: {formatBytes(result.totalSize)}{' '}
                · {result.fileCount} {t('createTorrent.files')} ·{' '}
                {result.pieceCount} {t('createTorrent.pieces')}
              </p>
              <p className="font-mono">
                {t('createTorrent.resultInfoHash')}: {infoHashShown}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={hashing || saving}
            onClick={handleClose}
          >
            {t('common.cancel')}
          </Button>
          {result ? (
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => void saveFile()}
            >
              {t('createTorrent.saveFile')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!sourcePath || hashing}
              onClick={() => void startCreate()}
            >
              {t('createTorrent.create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
