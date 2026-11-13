export interface PreparedEngineStartup {
  args: string[]
  reconcile: (isStopping: () => boolean) => Promise<void>
}

export interface EngineStartupGuard {
  prepare(args: readonly string[]): Promise<PreparedEngineStartup | null>
}
