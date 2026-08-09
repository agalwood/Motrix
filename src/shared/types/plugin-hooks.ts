import type { DownloadTask } from './task'

export type CtxJsonValue =
  | string
  | number
  | boolean
  | null
  | CtxJsonValue[]
  | { [k: string]: CtxJsonValue }

export interface BeforeCreateContextBase {
  readonly sourceUrl: string
  readonly createdBy: 'user' | 'protocol' | 'api'
  readonly requestedAt: number
}

export interface BeforeCreateHttpContextDTO extends BeforeCreateContextBase {
  readonly type: 'http'
  readonly uris: ReadonlyArray<string>
  readonly saveDir: string
  readonly filename?: string
  readonly connections?: number
  readonly headers: ReadonlyArray<{ name: string; value: string }>
  readonly proxy?: string
}

export interface BeforeCreateBtContextDTO extends BeforeCreateContextBase {
  readonly type: 'bt' | 'magnet'
  readonly infoHash?: string
  readonly trackers: ReadonlyArray<string>
  readonly displayName?: string
}

export interface BeforeFinalizeContextDTO extends BeforeCreateContextBase {
  readonly task: DownloadTask
  readonly filePath: string
}

export interface AfterCompleteContextDTO {
  readonly task: DownloadTask
  readonly filePath: string
}

export interface OnErrorContextDTO {
  readonly task: DownloadTask
  readonly error: { code: string; message: string }
}
