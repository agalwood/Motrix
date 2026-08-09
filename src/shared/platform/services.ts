export enum RunHost {
  Electron = 'electron',
  Node = 'node',
}

export interface PlatformServices {
  readonly host: RunHost
  readonly userDataDir: string
  readonly extraResourceDir: string
  readonly aria2BinaryPath: string
  readonly isDev: boolean
}
