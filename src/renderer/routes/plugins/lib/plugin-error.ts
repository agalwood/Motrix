/** Classify persisted error codes, including worker startup failures from older hosts. */
export function pluginErrorTitleKey(error: string | undefined) {
  if (
    /^plugin\.runtime\.(worker_start_failed|boot_failed|activation_failed):/.test(
      error ?? ''
    ) ||
    /^plugin\.runtime\.worker_crashed:.*Cannot find module.*quick-js-worker\.cjs/s.test(
      error ?? ''
    )
  )
    return 'plugins.detail.runtimeStartFailed'
  if (/^plugin\.runtime\.(worker_crashed|worker_exited):/.test(error ?? '')) {
    return 'plugins.detail.runtimeFailed'
  }
  return 'plugins.detail.attentionTitle'
}
