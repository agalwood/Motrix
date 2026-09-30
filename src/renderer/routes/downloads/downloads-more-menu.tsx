import { CheckIcon, MoreIcon } from '@renderer/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type CompletionShutdownState,
  completionShutdownStateSchema,
} from '@shared/schemas/completion-shutdown'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function DownloadsMoreMenu() {
  const { t } = useTranslation()
  const [state, setState] = useState<CompletionShutdownState | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [now, setNow] = useState(Date.now)
  const desktop = transport.platform !== 'web'

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    let generation = 0
    const apply = (value: unknown) => {
      const parsed = completionShutdownStateSchema.safeParse(value)
      if (!disposed && parsed.success) setState(parsed.data)
    }
    const refresh = () => {
      const revision = ++generation
      void transport
        .invoke(Queries.GetCompletionShutdown)
        .then((value) => {
          if (revision === generation) apply(value)
        })
        .catch(() => {})
    }
    const onChange = (value: unknown) => {
      ++generation
      apply(value)
    }
    transport.on(Events.CompletionShutdownChanged, onChange)
    const stop = transport.onConnectionChange?.((event) => {
      if (event.state === 'connected') refresh()
    })
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      disposed = true
      transport.off(Events.CompletionShutdownChanged, onChange)
      stop?.()
      window.removeEventListener('focus', refresh)
    }
  }, [desktop])

  useEffect(() => {
    setNow(Date.now())
    if (state?.phase !== 'countdown') return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [state?.phase])

  const active =
    state !== null &&
    ['waiting', 'countdown', 'preparing'].includes(state.phase)
  const available = desktop && state?.supported === true
  const description =
    !desktop || state?.supported === false
      ? t('panel.downloads.completionShutdown.unavailable')
      : state?.phase === 'countdown'
        ? t('panel.downloads.completionShutdown.countdown', {
            seconds: Math.max(
              0,
              Math.ceil(((state.deadline ?? now) - now) / 1_000)
            ),
          })
        : state?.phase === 'preparing'
          ? t('panel.downloads.completionShutdown.preparing')
          : state?.phase === 'requested'
            ? t('panel.downloads.completionShutdown.requested')
            : state?.phase === 'failed'
              ? t(
                  `panel.downloads.completionShutdown.${state.error ?? 'failed'}`
                )
              : active
                ? t('panel.downloads.completionShutdown.waiting')
                : t('panel.downloads.completionShutdown.detail')

  const toggle = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      // Live events own the state mirror; the result only reports command failure.
      const result = completionShutdownStateSchema.parse(
        await transport.invoke(Commands.SetCompletionShutdown, {
          enabled: !active,
        })
      )
      if (result.phase === 'failed') {
        toast.add({
          type: 'error',
          title: t(
            `panel.downloads.completionShutdown.${result.error ?? 'failed'}`
          ),
        })
      }
    } catch {
      toast.add({
        type: 'error',
        title: t('panel.downloads.completionShutdown.failed'),
      })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('panel.downloads.completionShutdown.more')}
        title={
          active ? description : t('panel.downloads.completionShutdown.more')
        }
        render={<button type="button" />}
        data-slot="downloads-more"
        data-active={active}
        className={cn(
          'app-no-drag relative flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/50 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground data-popup-open:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          active && 'border-primary/30 bg-primary/10 text-primary'
        )}
      >
        <MoreIcon className="size-3.5" aria-hidden="true" />
        {active && (
          <span
            aria-hidden="true"
            className="absolute -end-0.5 -top-0.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        data-menu-density="compact"
        className="w-52 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuItem
          disabled={!available || pending || state?.phase === 'requested'}
          onClick={() => void toggle()}
        >
          <CheckIcon
            aria-hidden="true"
            className={cn('size-4', !active && 'opacity-0')}
          />
          <span>
            {t(
              `panel.downloads.completionShutdown.${active ? 'disable' : 'enable'}`
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p
          role="status"
          className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {description}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
