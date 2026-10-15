import type { BootstrapProvider } from '@/background/BootstrapProvider'
import { NativeBootstrap } from '@/background/NativeBootstrap'
import { SafariBootstrap } from '@/background/SafariBootstrap'
import type { BrowserKind } from '@/shared/browserKind'

export function createBootstrapProvider(
  browser: BrowserKind,
  options: { timeoutMs?: number } = {}
): BootstrapProvider {
  return browser === 'safari'
    ? new SafariBootstrap(options)
    : new NativeBootstrap(options)
}
