import {
  encodeFileSelection,
  type RpcDownloadParams,
} from '../aria2/task-options'

function scalar(value: string): string {
  if (
    [...value].some((char) => {
      const code = char.codePointAt(0) ?? 0
      return code < 32 || code === 127
    })
  ) {
    throw new TypeError(
      'Download request values must not contain control characters'
    )
  }
  return value
}

/** Native submission policy: no aria2 resume, allocation, or compatibility switches. */
export function taijiDownloadOptions(
  params: RpcDownloadParams
): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {
    ...params.wireOptions,
    dir: params.saveDir,
  }
  if (params.filename !== undefined) options.out = scalar(params.filename)
  if (params.gid !== undefined) {
    if (!/^[a-f0-9]{16}$/i.test(params.gid))
      throw new TypeError('Invalid engine task ID')
    options.gid = params.gid
  }
  if (params.pause !== undefined) options.pause = String(params.pause)
  for (const [field, wire] of [
    ['dlLimit', 'max-download-limit'],
    ['ulLimit', 'max-upload-limit'],
    ['seedRatio', 'seed-ratio'],
    ['minSplitSize', 'min-split-size'],
  ] as const) {
    if (params[field] !== undefined) options[wire] = String(params[field])
  }
  if (params.connections !== undefined) {
    options.split = String(params.connections)
    options['max-connection-per-server'] = String(params.connections)
  } else if (params.split !== undefined) options.split = String(params.split)
  if (params.selectedFiles?.length)
    options['select-file'] = encodeFileSelection(params.selectedFiles)
  if (params.trackers) options['bt-tracker'] = params.trackers.join(',')
  if (params.userAgent !== undefined)
    options['user-agent'] = scalar(params.userAgent)
  if (params.headers)
    options.header = Object.entries(params.headers).map(
      ([name, value]) => `${scalar(name)}: ${scalar(value)}`
    )
  if (params.proxy !== undefined) options['all-proxy'] = scalar(params.proxy)
  if (params.noProxy !== undefined) options['no-proxy'] = scalar(params.noProxy)
  if (params.retainRequestContext) options['http-resume-context'] = 'true'
  if (params.deferFilePublication) {
    options['http-incomplete-suffix'] = '.motrix'
    options['http-host-finalize'] = 'true'
  }
  return options
}
