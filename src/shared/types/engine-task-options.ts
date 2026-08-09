/**
 * Options of a download as known to the engine, retrieved via the
 * GetEngineTaskOptions query. Field names mirror aria2's option
 * keys verbatim — they cross the IPC boundary as a passthrough
 * struct rather than getting domain-translated, because the same
 * shape goes back into createDownload/addTorrent on retry.
 *
 * `header` is `string | string[]` because aria2 may serialize a
 * single-line header set as a string and a multi-line set as
 * an array depending on how the option was originally written.
 */
export interface EngineTaskOptions {
  dir?: string
  out?: string
  header?: string | string[]
  split?: string
  'seed-time'?: string
  'seed-ratio'?: string
  'all-proxy'?: string
  'http-proxy'?: string
  'https-proxy'?: string
  'ftp-proxy'?: string
  'bt-tracker'?: string
  'select-file'?: string
  // Aria2 returns many more options — preserve them so the consumer
  // can pass them straight back to addTorrent/createDownload.
  [key: string]: string | string[] | undefined
}
