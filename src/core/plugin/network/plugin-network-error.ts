import { AppError, ErrorCode } from '@shared/errors'
import type { PluginNetworkFailure } from '@shared/schemas/plugin-network'

/** Only sanitized diagnostic data crosses the shell or logging boundary. */
export class PluginNetworkError extends AppError {
  constructor(readonly failure: PluginNetworkFailure) {
    super(ErrorCode.PluginNetworkFailed, `plugin.network.${failure.reason}`)
  }
}

export function networkFailure(
  error: unknown,
  context: Omit<PluginNetworkFailure, 'reason'>
): PluginNetworkFailure {
  if (error instanceof PluginNetworkError) return error.failure
  const codes: string[] = []
  const messages: string[] = []
  let cause = error
  for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
    const value = cause as {
      code?: string
      name?: string
      message?: string
      cause?: unknown
    }
    codes.push(String(value.code ?? ''), String(value.name ?? ''))
    messages.push(String(value.message ?? ''))
    cause = value.cause
  }
  const code = codes.join(' ')
  const message = messages.join(' ')
  let reason: PluginNetworkFailure['reason'] = 'network'
  if (/TIMEOUT|TIMEDOUT|TimeoutError/.test(code)) reason = 'timeout'
  else if (/ENOTFOUND|EAI_AGAIN/.test(code)) reason = 'dns'
  else if (/CERT|TLS|SSL/.test(code)) reason = 'certificate'
  else if (
    context.route === 'proxy' &&
    (/Proxy.*\b407\b/i.test(message) || /UND_ERR_SOCKS5_AUTH/.test(code))
  )
    reason = 'proxyAuth'
  else if (context.route === 'proxy' && /ECONNREFUSED|UND_ERR_PRX/.test(code))
    reason = 'proxyConnect'
  else if (/AbortError/.test(code)) reason = 'cancelled'
  return { ...context, reason }
}
