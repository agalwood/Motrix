import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type PendingPairRequestInfo,
  pairRequestKey,
} from '@shared/protocol/bridge'

type ExtensionRequest = Extract<PendingPairRequestInfo, { kind: 'extension' }>
type Translate = (
  key: string,
  values?: Readonly<Record<string, string | number>>
) => string

export class ExtensionPairingTerminalError extends Error {
  constructor(
    readonly reason:
      | 'ttyRequired'
      | 'cancelled'
      | 'invalidSelection'
      | 'unavailable'
  ) {
    super(reason)
  }
}

export interface PairingTerminal {
  readonly interactive: boolean
  readonly signal: AbortSignal
  begin(): void
  show(lines: string[]): void
  select(prompt: string, signal: AbortSignal): Promise<string>
  clear(): void
  close(): void
}

/** Removes terminal commands, multiline spoofing and invisible direction marks. */
export function terminalPairingText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 160)
}

export function createPairingTerminal(): PairingTerminal {
  const controller = new AbortController()
  let reader: ReturnType<typeof createInterface> | undefined
  let opened = false
  const cancel = () => controller.abort()
  const clear = () => {
    if (opened) process.stdout.write('\x1b[2J\x1b[H')
  }
  return {
    interactive:
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      process.stderr.isTTY === true,
    signal: controller.signal,
    begin() {
      process.stdout.write('\x1b[?1049h')
      opened = true
      reader = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })
      reader.on('SIGINT', cancel)
      reader.on('SIGTSTP', cancel)
      reader.on('close', cancel)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP'] as const)
        process.on(signal, cancel)
    },
    show(lines) {
      clear()
      process.stdout.write(`${lines.join('\n')}\n`)
    },
    async select(prompt, signal) {
      if (!reader) throw new ExtensionPairingTerminalError('cancelled')
      return reader.question(prompt, { signal })
    },
    clear,
    close() {
      try {
        clear()
        if (opened) process.stdout.write('\x1b[?1049l')
      } finally {
        opened = false
        reader?.close()
        for (const signal of [
          'SIGINT',
          'SIGTERM',
          'SIGHUP',
          'SIGTSTP',
        ] as const)
          process.off(signal, cancel)
      }
    },
  }
}

function sameRequest(left: ExtensionRequest, right: ExtensionRequest): boolean {
  return (
    pairRequestKey(left) === pairRequestKey(right) &&
    left.code === right.code &&
    left.identity === right.identity &&
    left.verifiedOrigin === right.verifiedOrigin &&
    left.originHost === right.originHost &&
    left.claimedExtensionId === right.claimedExtensionId &&
    left.attestationClass === right.attestationClass &&
    left.publicAuthority === right.publicAuthority &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  )
}

export async function runExtensionPairingTerminal(options: {
  terminal: PairingTerminal
  listPending(signal: AbortSignal): Promise<PendingPairRequestInfo[]>
  now(): number
  t: Translate
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<'none' | 'ended'> {
  const { terminal, listPending, now, t } = options
  if (!terminal.interactive)
    throw new ExtensionPairingTerminalError('ttyRequired')
  const wait =
    options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const expired = new AbortController()
  const signal = AbortSignal.any([terminal.signal, expired.signal])
  const armDeadline = (deadline: number) => {
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(
      () => {
        // Clear immediately, even while an HTTP response is still in flight.
        try {
          terminal.clear()
        } finally {
          expired.abort()
        }
      },
      Math.max(0, deadline - now())
    )
  }
  try {
    terminal.begin()
    const pending = (await listPending(signal)).filter(
      (request): request is ExtensionRequest =>
        request.kind === 'extension' && request.expiresAt > now()
    )
    if (pending.length === 0) return 'none'
    armDeadline(
      Math.min(
        now() + 120_000,
        Math.max(...pending.map((request) => request.expiresAt))
      )
    )
    terminal.show([
      t('operatorAdmin.extension.heading'),
      t('operatorAdmin.extension.identityNotice'),
      ...pending.map((request, index) =>
        t('operatorAdmin.extension.row', {
          index: index + 1,
          browser: request.browser,
          identity: request.identity,
          origin: terminalPairingText(
            request.verifiedOrigin ?? request.extensionId
          ),
          claimedId: terminalPairingText(
            request.claimedExtensionId ?? request.extensionId
          ),
          authority: terminalPairingText(request.publicAuthority ?? ''),
          seconds: Math.max(0, Math.ceil((request.expiresAt - now()) / 1_000)),
        })
      ),
    ])
    const selection = (
      await terminal.select(t('operatorAdmin.extension.select'), signal)
    ).trim()
    if (!/^[1-9]\d{0,3}$/.test(selection))
      throw new ExtensionPairingTerminalError('invalidSelection')
    const selected = pending[Number(selection) - 1]
    if (!selected) throw new ExtensionPairingTerminalError('invalidSelection')
    if (selected.expiresAt <= now())
      throw new ExtensionPairingTerminalError('unavailable')
    armDeadline(selected.expiresAt)

    const getSelected = async (): Promise<ExtensionRequest | undefined> => {
      const requests = await listPending(signal)
      return requests.find(
        (request): request is ExtensionRequest =>
          request.kind === 'extension' &&
          pairRequestKey(request) === pairRequestKey(selected)
      )
    }
    const confirmed = await getSelected()
    if (
      !confirmed ||
      !sameRequest(selected, confirmed) ||
      confirmed.expiresAt <= now() ||
      signal.aborted
    ) {
      throw new ExtensionPairingTerminalError('unavailable')
    }
    terminal.show([
      t('operatorAdmin.extension.code', { code: confirmed.code }),
      t('operatorAdmin.extension.instructions'),
    ])
    while (!signal.aborted && now() < selected.expiresAt) {
      await wait(Math.min(1_000, selected.expiresAt - now()), signal)
      const current = await getSelected()
      if (!current) return 'ended'
      if (!sameRequest(selected, current))
        throw new ExtensionPairingTerminalError('unavailable')
    }
    throw new ExtensionPairingTerminalError('unavailable')
  } catch (error) {
    if (terminal.signal.aborted)
      throw new ExtensionPairingTerminalError('cancelled')
    if (expired.signal.aborted)
      throw new ExtensionPairingTerminalError('unavailable')
    throw error
  } finally {
    clearTimeout(expiryTimer)
    terminal.close()
  }
}
