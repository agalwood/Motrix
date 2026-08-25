import { Toast } from '@base-ui/react/toast'
import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { SEVERITY_ICONS } from '@renderer/components/ui/severity-icons'
import { browserDisplayName } from '@renderer/lib/browser-name'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import {
  DESKTOP_WINDOW_CHROME_HEIGHT,
  WINDOW_CHROME_EDGE_GAP,
} from '@shared/constants/window-chrome'
import type {
  IdentityTriState,
  PairRequestPayload,
} from '@shared/protocol/bridge'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type AppToastType = 'success' | 'info' | 'warning' | 'error'

/** Module-level manager: a global toast entry point. Call sites do
 *  `toast.add({...})` / `toast.close(id)`; rendering happens in <Toaster/>. */
export const toast = Toast.createToastManager()

/**
 * Shape a pairing-prompt host (`usePairRequestPrompts`) puts in
 * `toast.add({ data: { pairRequest } })`: the wire payload plus the decision
 * callback(s) the pairing branch below wires its buttons to. Kept here (not
 * in the hook's file) because this is the contract the renderer, not the
 * caller, owns — `ToastList` is what interprets `data`.
 *
 * Discriminated on `kind`, deliberately asymmetric: a `cli` prompt keeps a
 * real Allow/Deny decision (`onAllow` + `onDeny`), but under MBP1 an
 * `extension` prompt has no Allow to give — approval is proven by typing the
 * §7.1 code into the extension, not by a click here — so it carries only
 * `onDeny`. Giving both variants an `onAllow` would let a future render path
 * wire up an "Allow" button that (per `ResolvePairParams`) can't actually
 * express approval for an extension request.
 */
export type PairRequestToastData = {
  pairRequest:
    | (Extract<PairRequestPayload, { kind: 'cli' }> & {
        onAllow: () => void
        onDeny: () => void
      })
    | (Extract<PairRequestPayload, { kind: 'extension' }> & {
        onDeny: () => void
      })
}

/** i18n copy for a pairing prompt. Exported so `usePairRequestPrompts` can
 *  compute the same `title`/`description` at `toast.add()` time — Base UI's
 *  high-priority alert region announces from the toast OPTIONS, not from
 *  what `ToastList` renders, so the host must feed it identical copy for
 *  the prompt to be audible to screen readers. `ToastList` below still
 *  passes its own `children` (which `Toast.Title`/`Toast.Description`
 *  prefer over `toast.title`/`toast.description`), recomputed from the
 *  live `t` on every render, so a locale switch updates the visible copy;
 *  only the add-time announcement is frozen to whatever `t` was current
 *  when the prompt was created. */
export function pairRequestCopy(
  payload: PairRequestPayload,
  t: ReturnType<typeof useTranslation>['t']
) {
  return payload.kind === 'cli'
    ? {
        title: t('settings.integration.cli.pairToast.title', {
          name: payload.clientName,
        }),
        description: t('settings.integration.cli.pairToast.code', {
          code: payload.userCode,
        }),
        allowLabel: t('settings.integration.cli.pairToast.allow'),
        denyLabel: t('settings.integration.cli.pairToast.deny'),
      }
    : {
        // MBP1 forbids displaying the self-reported extension name (§5),
        // and the raw extension id means nothing to a person in a headline —
        // it is the description instead, shown exactly once. The browser
        // rides in the title, so there is no separate "From …" row.
        title: t('settings.integration.browser.pairToast.title', {
          browser: browserDisplayName(payload.browser),
        }),
        // The full id, verbatim — it must be comparable against
        // chrome://extensions character by character; only the label is terse.
        description: t('settings.integration.browser.pairToast.extensionId', {
          id: payload.extensionId,
        }),
        // No allowLabel: an extension prompt has no Allow affordance (see
        // `PairRequestToastData`'s doc comment).
        denyLabel: t('settings.integration.browser.pairToast.deny'),
      }
}

/**
 * §5 display rules for the extension identity tri-state, mirroring the
 * `Record<Tone, …>` idiom used for plugin audience tones
 * (`routes/plugins/lib/audience.ts`) so the union stays compile-time
 * exhaustive. Only `official` carries a label that names Motrix — §5: "May
 * show Motrix branding" is exclusive to that state.
 */
const IDENTITY_BADGE_META: Record<
  IdentityTriState,
  {
    badgeVariant: 'default' | 'outline' | 'destructive'
    labelKey: string
  }
> = {
  official: {
    badgeVariant: 'default',
    labelKey: 'settings.integration.browser.pairToast.identityLabel.official',
  },
  'attested-non-official': {
    badgeVariant: 'outline',
    labelKey: 'settings.integration.browser.pairToast.identityLabel.attested',
  },
  unverified: {
    badgeVariant: 'destructive',
    labelKey: 'settings.integration.browser.pairToast.identityLabel.unverified',
  },
}

/** One lookup, no two-table drift — the icon + accent map itself lives in
 *  `ui/severity-icons.ts` so the notifications page
 *  (`routes/notifications/notifications-page.tsx`) can reuse it without
 *  importing this whole toast module. Unknown types (e.g. Base UI's
 *  internal 'loading') resolve to no icon. */
const TOAST_TYPE_META = SEVERITY_ICONS

function ToastList() {
  const { t } = useTranslation()
  const { toasts } = Toast.useToastManager()
  return toasts.map((item) => {
    const pairRequest = (item.data as PairRequestToastData | undefined)
      ?.pairRequest
    if (pairRequest) {
      // Structural fork, not a copy swap: a cli request keeps a real
      // Allow/Deny decision, while an extension request (MBP1) has no Allow
      // to give and instead surfaces the §7.1 pairing code plus the §5
      // identity tri-state — content the cli branch has no equivalent for.
      const rootClassName =
        'pointer-events-auto flex w-full items-start gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md transition-all duration-200 motion-reduce:transition-none data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:pointer-events-none data-limited:invisible data-limited:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0'
      const closeButton = (
        <Toast.Close
          aria-label={t('common.close')}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Toast.Close>
      )

      if (pairRequest.kind === 'cli') {
        const copy = pairRequestCopy(pairRequest, t)
        return (
          <Toast.Root key={item.id} toast={item} className={rootClassName}>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 wrap-anywhere">
              <Toast.Title className="text-sm font-medium">
                {copy.title}
              </Toast.Title>
              <Toast.Description className="text-xs text-muted-foreground">
                {copy.description}
              </Toast.Description>
              <div className="mt-1.5 flex gap-2">
                <Button type="button" size="xs" onClick={pairRequest.onAllow}>
                  {copy.allowLabel}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={pairRequest.onDeny}
                >
                  {copy.denyLabel}
                </Button>
              </div>
            </div>
            {closeButton}
          </Toast.Root>
        )
      }

      const copy = pairRequestCopy(pairRequest, t)
      const identityMeta = IDENTITY_BADGE_META[pairRequest.identity]
      const isUnverified = pairRequest.identity === 'unverified'
      return (
        <Toast.Root key={item.id} toast={item} className={rootClassName}>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 wrap-anywhere">
            <div className="flex items-center gap-1.5">
              {isUnverified && (
                <SEVERITY_ICONS.warning.icon
                  className={cn(
                    'size-3.5 shrink-0',
                    SEVERITY_ICONS.warning.iconClassName
                  )}
                  aria-hidden="true"
                />
              )}
              <Badge
                variant={identityMeta.badgeVariant}
                className="rounded text-[10px]"
              >
                {t(identityMeta.labelKey)}
              </Badge>
            </div>
            <Toast.Title className="text-sm font-medium">
              {copy.title}
            </Toast.Title>
            {/* Raw id, not the self-reported name (§5) — same font-mono
             *  truncate treatment as the trusted-extensions table. */}
            <Toast.Description className="truncate font-mono text-[11px] text-muted-foreground">
              {copy.description}
            </Toast.Description>
            {isUnverified && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t(
                  'settings.integration.browser.pairToast.identityUnverifiedWarning'
                )}
              </p>
            )}
            <div className="mt-1 flex flex-col gap-1 rounded border border-border bg-muted/30 px-2 py-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                  {t('settings.integration.browser.pairToast.pairCode')}
                </span>
                <CopyButton
                  content={pairRequest.code}
                  size="xs"
                  variant="ghost"
                  aria-label={t(
                    'settings.integration.browser.pairToast.copyCode'
                  )}
                  className="-my-0.5 -me-1 size-6 p-0 text-muted-foreground hover:text-foreground"
                />
              </div>
              {/* The §7.1 PAKE password, rendered verbatim — never
               *  reformatted and never logged (§7.1/§11). */}
              <span className="text-center font-mono text-base font-semibold tracking-widest">
                {pairRequest.code}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t('settings.integration.browser.pairToast.pairCodeHint')}
              </span>
            </div>
            <div className="mt-1.5 flex gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={pairRequest.onDeny}
              >
                {copy.denyLabel}
              </Button>
            </div>
          </div>
          {closeButton}
        </Toast.Root>
      )
    }

    const typeMeta = item.type
      ? TOAST_TYPE_META[item.type as AppToastType]
      : undefined
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className="pointer-events-auto flex w-full items-start gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md transition-all duration-200 motion-reduce:transition-none data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:pointer-events-none data-limited:invisible data-limited:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
      >
        {typeMeta ? (
          <typeMeta.icon
            className={cn('mt-0.5 size-4 shrink-0', typeMeta.iconClassName)}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="text-xs text-muted-foreground" />
        </div>
        <Toast.Action className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent" />
        <Toast.Close
          aria-label={t('common.close')}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Toast.Close>
      </Toast.Root>
    )
  })
}

export function Toaster() {
  const { t } = useTranslation()
  const avoidDesktopChrome =
    __MOTRIX_TARGET__ === 'electron' &&
    (transport.platform === 'win32' ||
      transport.platform === 'linux' ||
      (transport.platform === 'darwin' && __MOTRIX_PREVIEW_MAC_MENU__))
  return (
    // Base UI defaults `limit` to 3; the 4th-oldest toast onward gets
    // `data-limited` (styled below as invisible + unclickable). A live
    // pairing prompt is `timeout: 0` and can sit indefinitely, so 3 newer
    // toasts stacking on top of it would hide it AND make its Allow/Deny
    // buttons unclickable, starving it toward its backend TTL as a silent
    // auto-deny. 5 gives enough headroom for a pairing prompt plus a
    // handful of transient toasts to coexist visibly.
    <Toast.Provider toastManager={toast} limit={5}>
      <Toast.Portal>
        <Toast.Viewport
          aria-label={t('notification.center.toastRegionAria')}
          className={cn(
            'pointer-events-none fixed end-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none',
            !avoidDesktopChrome && 'top-4'
          )}
          style={
            avoidDesktopChrome
              ? {
                  top: DESKTOP_WINDOW_CHROME_HEIGHT + WINDOW_CHROME_EDGE_GAP,
                }
              : undefined
          }
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}
