import type { MdxpError } from '@motrix/mdxp'
import { PairAppCodes, type ResolvePairResult } from '@shared/protocol/bridge'
import type { DeviceCodeService } from './device-code-service'
import type { PairedClient } from './pairing-service'

/**
 * Shared cli (device-code) ResolvePair logic for BOTH shells (desktop IPC +
 * server /rpc). Approving mints a token (announced via `onPaired`); denying
 * reports `{ ok: false, reason: 'unavailable' }` on a non-pending entry —
 * mirroring the extension `PairingDialogController.settle()` contract, which
 * never reports apparent success for a decision that didn't actually land. A
 * request that is no longer pending (expired / denied-elsewhere / already
 * approved) makes `approve()` throw ResourceUnavailable — we convert that to
 * the same `{ ok: false, reason: 'unavailable' }` RETURN VALUE rather than
 * letting it throw, because a thrown MDXP error loses its `data.appCode` over
 * the web `/rpc` transport (it becomes a generic 500 message). A return value
 * round-trips intact over both transports. Genuinely unexpected errors still
 * throw.
 */
export async function resolveCliPair(
  deviceCode: DeviceCodeService,
  params: { requestId: string; decision: 'allow' | 'deny' },
  onPaired: (paired: PairedClient) => void
): Promise<ResolvePairResult> {
  try {
    if (params.decision === 'allow') {
      const paired = await deviceCode.approve(params.requestId)
      onPaired(paired)
    } else if (!deviceCode.deny(params.requestId)) {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true }
  } catch (err) {
    const appCode = (err as MdxpError | undefined)?.data?.appCode
    if (appCode === PairAppCodes.Unavailable) {
      return { ok: false, reason: 'unavailable' }
    }
    throw err
  }
}
