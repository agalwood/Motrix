export interface UpdateQuitEventSource {
  on(event: 'before-quit-for-update', listener: () => void): unknown
}

export interface UpdateQuitPreparationOptions {
  updater: UpdateQuitEventSource
  markForceQuit: () => void
  setWillQuit: (value: boolean) => void
}

/** Prepare Motrix's quit policy before Electron closes windows for an update. */
export function registerUpdateQuitPreparation(
  options: UpdateQuitPreparationOptions
): void {
  options.updater.on('before-quit-for-update', () => {
    options.markForceQuit()
    options.setWillQuit(true)
  })
}
