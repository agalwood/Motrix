import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import {
  BridgeCommands,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type { CommandChannel } from '@shared/protocol/commands'

/**
 * Invoke ResolvePair and surface a one-line toast when the request is no longer
 * pending (expired / denied-elsewhere / already approved). Shared by the
 * app-wide pairing toast and the pending-approvals inbox so both give identical
 * feedback. Returns the typed result for callers that branch on it; tolerates
 * an `undefined` reply (extension path / older handlers) by treating it as ok.
 */
export async function resolvePairWithFeedback(
  params: ResolvePairParams,
  t: (key: string) => string
): Promise<ResolvePairResult> {
  const result = (await transport.invoke(
    BridgeCommands.ResolvePair as unknown as CommandChannel,
    params
  )) as ResolvePairResult | undefined
  if (result && result.ok === false && result.reason === 'unavailable') {
    const key =
      params.kind === 'cli'
        ? 'settings.integration.cli.pairUnavailable'
        : 'settings.integration.browser.pairUnavailable'
    toast.add({ title: t(key) })
  }
  return result ?? { ok: true }
}
