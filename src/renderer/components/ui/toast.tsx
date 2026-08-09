import { Toast } from '@base-ui/react/toast'
import { Button } from '@renderer/components/ui/button'
import { SEVERITY_ICONS } from '@renderer/components/ui/severity-icons'
import { cn } from '@renderer/lib/utils'
import type { PairRequestPayload } from '@shared/protocol/bridge'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type AppToastType = 'success' | 'info' | 'warning' | 'error'

/** Module-level manager: a global toast entry point. Call sites do
 *  `toast.add({...})` / `toast.close(id)`; rendering happens in <Toaster/>. */
export const toast = Toast.createToastManager()

/**
 * Shape a pairing-prompt host (`usePairRequestPrompts`) puts in
 * `toast.add({ data: { pairRequest } })`: the wire payload plus the two
 * decision callbacks the pairing branch below wires its Allow/Deny buttons
 * to. Kept here (not in the hook's file) because this is the contract the
 * renderer, not the caller, owns — `ToastList` is what interprets `data`.
 */
export interface PairRequestToastData {
  pairRequest: PairRequestPayload & {
    onAllow: () => void
    onDeny: () => void
  }
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
        title: t('settings.integration.browser.pairToast.title', {
          name: payload.extensionName,
        }),
        description: t('settings.integration.browser.pairToast.from', {
          browser: payload.browser === 'chromium' ? 'Chrome / Edge' : 'Firefox',
        }),
        allowLabel: t('settings.integration.browser.pairToast.allow'),
        denyLabel: t('settings.integration.browser.pairToast.deny'),
      }
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
      const copy = pairRequestCopy(pairRequest, t)
      return (
        <Toast.Root
          key={item.id}
          toast={item}
          className="pointer-events-auto flex w-full items-start gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md transition-all duration-200 motion-reduce:transition-none data-ending-style:translate-y-2 data-ending-style:opacity-0 data-limited:pointer-events-none data-limited:invisible data-limited:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
        >
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
          <Toast.Close
            aria-label={t('common.close')}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Toast.Close>
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
          className="pointer-events-none fixed top-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}
