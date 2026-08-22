import { RunMode } from '@shared/constants'

export interface MainWindowStartupPlanInput {
  openedAtLogin: boolean
  runMode: RunMode
  releaseWhenHidden: boolean
}

export interface MainWindowStartupPlan {
  create: boolean
  show: boolean
}

/** Decide whether startup needs a renderer at all. A visible launch always
 * creates one; background launches may stay headless when release is safe. */
export function resolveMainWindowStartupPlan({
  openedAtLogin,
  runMode,
  releaseWhenHidden,
}: MainWindowStartupPlanInput): MainWindowStartupPlan {
  const show = !openedAtLogin && runMode !== RunMode.TrayOnly
  return {
    create: show || !releaseWhenHidden,
    show,
  }
}
