import { normalizeTarget } from '@/background/capture/normalizeTarget'
import type { HandoffGuard } from '@/background/handoff/guard'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { pickDownloadUrl } from '@/background/interception/eligibility'
import { describeUrlForLog, log } from '@/background/log'
import { decideTakeover } from '@/background/policy/decideTakeover'
import type { TakeoverConfig } from '@/shared/takeover'

/** Keep the original response alive: neither metadata probes nor an open form
 * can prove that a one-use URL will tolerate another request. */
export async function confirmInterceptedDownload(
  item: {
    url: string
    finalUrl?: string
    totalBytes?: number
    referrer?: string
    filename?: string
    mime?: string
  },
  config: TakeoverConfig,
  capturedWindow: Promise<number | null> | undefined,
  deps: ChromiumInterceptionDeps,
  capturedGuard?: HandoffGuard
): Promise<void> {
  if (!deps.confirm) return
  const target = normalizeTarget({
    url: pickDownloadUrl(item),
    ...(item.referrer ? { referrer: item.referrer } : {}),
    ...(item.filename ? { suggestedFilename: item.filename } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    sizeBytes:
      typeof item.totalBytes === 'number' && item.totalBytes > 0
        ? item.totalBytes
        : null,
    origin: 'auto',
  })
  const decision = decideTakeover(config, target)
  log.debug(
    '[takeover] confirm-path decision=',
    decision,
    'sizeBytes=',
    target.sizeBytes,
    'url=',
    describeUrlForLog(target.url)
  )
  if (decision !== 'motrix') return
  const guard = capturedGuard ?? (await deps.captureGuard())
  if (!guard) return
  const windowId = await capturedWindow
  guard.assertCurrent()
  await deps.confirm(target, windowId ?? undefined, guard)
}
