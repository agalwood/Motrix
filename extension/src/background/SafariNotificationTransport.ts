import { z } from 'zod'
import { rpcDeadline } from '@/background/RpcRecovery'
import { extensionBrowser as browser } from '@/shared/browser'
import type {
  NotificationCapability,
  NotificationTestResult,
  NotifyInput,
} from '@/shared/notifications'
import { hasPackagedSafariNativeMessaging } from '@/shared/safariNative'

const authorizationSchema = z.enum([
  'authorized',
  'notDetermined',
  'denied',
  'unavailable',
])
const responseSchema = z.object({
  action: z.enum([
    'notifications.status',
    'notifications.send',
    'notifications.test',
    'notifications.openSettings',
  ]),
  protocolVersion: z.literal(1),
  notificationVersion: z.literal(1),
  requestId: z.string().uuid(),
  authorization: authorizationSchema,
  // Older prototypes only implemented status/test and cannot deliver task events.
  delivery: z.literal('direct').optional(),
  reason: z.literal('rateLimited').optional(),
  status: z
    .enum([
      'accepted',
      'duplicate',
      'suppressed',
      'failed',
      'unknown',
      'opened',
    ])
    .optional(),
})

export type SafariNotificationCapability = NotificationCapability

export function notificationText(value: string, limit: number): string {
  const cleaned = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? ' '
        : character
    })
    .join('')
    .trim()
  return Array.from(cleaned).slice(0, limit).join('')
}

type NativeMessage = (message: Record<string, unknown>) => Promise<unknown>

/** Correlation and timeouts are required even for a locally installed host. */
export class SafariNotificationTransport {
  constructor(
    private readonly nativeMessage: NativeMessage = (message) =>
      browser.runtime.sendNativeMessage('app.motrix.bridge', message),
    private readonly packaged = hasPackagedSafariNativeMessaging
  ) {}

  private async request(
    action: z.infer<typeof responseSchema>['action'],
    fields: Record<string, unknown> = {}
  ) {
    const requestId = crypto.randomUUID()
    const response = responseSchema.parse(
      await rpcDeadline(
        this.nativeMessage({
          action,
          protocolVersion: 1,
          notificationVersion: 1,
          requestId,
          ...fields,
        }),
        3000,
        'native notification'
      )
    )
    if (response.action !== action || response.requestId !== requestId)
      throw new Error('invalid-notification-response')
    return response
  }

  async capability(): Promise<SafariNotificationCapability> {
    if (!this.packaged())
      return { available: false, authorization: 'unavailable' }
    try {
      const response = await this.request('notifications.status')
      return {
        available: response.delivery === 'direct',
        authorization: response.authorization,
      }
    } catch {
      return { available: false, authorization: 'unavailable' }
    }
  }

  async test(): Promise<NotificationTestResult> {
    const capability = await this.capability()
    if (!capability.available || capability.authorization !== 'authorized')
      return 'suppressed'
    try {
      const response = await this.request('notifications.test')
      if (response.status === 'accepted' || response.status === 'duplicate')
        return 'accepted'
      return response.status === 'failed' || response.status === 'suppressed'
        ? response.status
        : 'unknown'
    } catch {
      // A test is never automatically retried: the first attempt may be visible.
      return 'unknown'
    }
  }

  async openSettings(): Promise<boolean> {
    if (!(await this.capability()).available) return false
    try {
      return (
        (await this.request('notifications.openSettings')).status === 'opened'
      )
    } catch {
      return false
    }
  }

  async send(
    input: NotifyInput,
    eventId: string = crypto.randomUUID(),
    options: { expiresAt?: number; canSend?: () => Promise<boolean> } = {}
  ): Promise<
    | 'accepted'
    | 'duplicate'
    | 'suppressed'
    | 'failed'
    | 'unknown'
    | 'rateLimited'
  > {
    const capability = await this.capability()
    if (!capability.available || capability.authorization !== 'authorized')
      return 'suppressed'
    const fields = {
      eventId,
      kind: input.kind ?? 'download.feedback',
      title: notificationText(input.title, 120),
      body: notificationText(input.message, 300),
      expiresAt: options.expiresAt ?? Date.now() + 120_000,
    }
    // A lost native reply may be retried only with the same event identity.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.canSend && !(await options.canSend())) return 'suppressed'
      if (fields.expiresAt <= Date.now() || input.isCurrent?.() === false)
        return 'suppressed'
      try {
        const response = await this.request('notifications.send', fields)
        if (
          response.status === 'suppressed' &&
          response.reason === 'rateLimited'
        )
          return 'rateLimited'
        return response.status === 'opened'
          ? 'unknown'
          : (response.status ?? 'unknown')
      } catch {
        if (attempt === 1) return 'unknown'
      }
    }
    return 'unknown'
  }
}
