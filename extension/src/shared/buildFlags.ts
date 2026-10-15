declare const __MOTRIX_BUILD__: 'webstore' | 'full' | undefined

export const BUILD_VARIANT: 'webstore' | 'full' =
  typeof __MOTRIX_BUILD__ === 'string' ? __MOTRIX_BUILD__ : 'full'

export function isWebStoreBuild(): boolean {
  return BUILD_VARIANT === 'webstore'
}

declare const __MOTRIX_DEV_PAIR_BACKOFF_MS__: number | undefined

/**
 * Local-debug override for the §7.3 first-pair backoff base window
 * (`MOTRIX_DEV_PAIR_BACKOFF_MS=1000 pnpm build:chromium` → lockouts of
 * 1s/2s/4s… instead of 30s/60s/120s…). Build-time only, and doubly fenced
 * out of Web Store builds: vite.config.ts forces the define to `undefined`
 * there, and this guard refuses it even if that ever regressed — a §7.3
 * security parameter must not be tunable in a shipped artifact.
 */
export const DEV_PAIR_BACKOFF_MS: number | undefined =
  typeof __MOTRIX_DEV_PAIR_BACKOFF_MS__ === 'number' &&
  BUILD_VARIANT !== 'webstore'
    ? __MOTRIX_DEV_PAIR_BACKOFF_MS__
    : undefined
