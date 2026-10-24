import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  extractAria2ProxyCredentials,
  normalizeAria2TaskProxyUrl,
} from '@core/proxy/aria2-proxy-routing'
import { admitDownloadSources } from '@core/task/source-admission'
import { AppError, ErrorCode } from '@shared/errors'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type {
  CreateDownloadParams,
  LegacyHttpBindingProof,
} from '../engine-adapter'
import type { Aria2LegacyCheckpoint } from './aria2-legacy-checkpoint'
import { legacyWirePath } from './aria2-legacy-path'
import type { Aria2RpcClient } from './aria2-rpc-client'

const fixedOptions = {
  'always-resume': 'true',
  continue: 'false',
  'allow-overwrite': 'false',
  'auto-file-renaming': 'false',
  'remove-control-file': 'false',
  'file-allocation': 'none',
  'follow-torrent': 'false',
  'follow-metalink': 'false',
  'check-integrity': 'false',
  'http-accept-gzip': 'false',
  'no-want-digest-header': 'false',
  'proxy-method': 'get',
  'max-http-redirect': '0',
  'no-netrc': 'true',
  'http-user': '',
  'http-passwd': '',
  'http-auth-challenge': 'false',
  'conditional-get': 'false',
  'http-no-cache': 'false',
  'use-head': 'false',
  'dry-run': 'false',
  referer: '',
  'load-cookies': '',
  'http-proxy': '',
  'http-proxy-user': '',
  'http-proxy-passwd': '',
  'https-proxy': '',
  'https-proxy-user': '',
  'https-proxy-passwd': '',
  'ftp-proxy': '',
  'ftp-proxy-user': '',
  'ftp-proxy-passwd': '',
} as const

function headerValues(
  header: EngineTaskOptions['header'],
  name: string
): string[] {
  const lines = Array.isArray(header) ? header : (header ?? '').split('\n')
  return lines.flatMap((line) => {
    const colon = line.indexOf(':')
    return colon >= 0 && line.slice(0, colon).trim().toLowerCase() === name
      ? [line.slice(colon + 1).trim()]
      : []
  })
}

function validEntityTag(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= 512 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    [...value.slice(1, -1)].every(
      (character) =>
        character !== '"' &&
        character.charCodeAt(0) > 32 &&
        character.charCodeAt(0) !== 127
    )
  )
}

function invalid(): AppError {
  return new AppError(
    ErrorCode.InvalidSelection,
    'legacyImport.errors.activationUncertain'
  )
}

function requestMatches(
  options: EngineTaskOptions,
  input: LegacyHttpBindingProof
): boolean {
  if (!input.request) return true
  const expected = new Map<string, string>()
  for (const [name, value] of Object.entries(input.request.headers ?? {})) {
    const key = name.toLowerCase()
    if (expected.has(key)) return false
    if (!['range', 'if-range', 'if-match', 'accept-encoding'].includes(key))
      expected.set(key, value.trim())
  }
  expected.set('if-match', input.entityTag)
  expected.set('accept-encoding', 'identity')
  if (!expected.has('cookie')) expected.set('cookie', '')
  if (!expected.has('accept')) expected.set('accept', '*/*')
  const lines = Array.isArray(options.header)
    ? options.header
    : (options.header ?? '').split('\n')
  const actual = new Map<string, string>()
  for (const line of lines) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return false
    const key = line.slice(0, colon).trim().toLowerCase()
    if (actual.has(key)) return false
    actual.set(key, line.slice(colon + 1).trim())
  }
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  )
    return false
  if (
    options['user-agent'] !== input.request.userAgent ||
    (options['no-proxy'] ?? '') !== (input.request.noProxy ?? '')
  )
    return false
  const proxy = input.request.proxy?.trim()
  if (!proxy)
    return (
      !options['all-proxy'] &&
      !options['all-proxy-user'] &&
      !options['all-proxy-passwd']
    )
  const expectedProxy = normalizeAria2TaskProxyUrl(proxy)
  const credentials = extractAria2ProxyCredentials(proxy)
  const actualProxy =
    typeof options['all-proxy'] === 'string'
      ? normalizeAria2TaskProxyUrl(options['all-proxy'])
      : null
  if (!expectedProxy || !actualProxy || !credentials) return false
  expectedProxy.username = expectedProxy.password = ''
  return (
    expectedProxy.href === actualProxy.href &&
    (options['all-proxy-user'] ?? '') === credentials.username &&
    (options['all-proxy-passwd'] ?? '') === credentials.password
  )
}

/** Pin the verified request and original output after all caller passthrough options. */
export async function pinLegacyHttpOptions(
  params: CreateDownloadParams,
  options: Record<string, string | string[]>,
  checkpoint: Aria2LegacyCheckpoint
): Promise<void> {
  const context = params.legacyCheckpointActivation
  if (!context) return
  const tags = headerValues(options.header, 'if-match')
  const encoding = headerValues(options.header, 'accept-encoding')
  const pieceLength = Number(options['piece-length'])
  if (
    !params.gid ||
    !/^[a-f0-9]{16}$/.test(params.gid) ||
    /^0+$/.test(params.gid) ||
    params.uris.length !== 1 ||
    !/^https?:\/\//i.test(params.uris[0]) ||
    !params.filename ||
    path.basename(params.filename) !== params.filename ||
    !path.isAbsolute(params.saveDir) ||
    path.resolve(params.saveDir) !== params.saveDir ||
    path.join(params.saveDir, params.filename) !== context.targetPath ||
    params.resumePolicy !== 'checkpoint' ||
    params.pause !== true ||
    !Number.isSafeInteger(pieceLength) ||
    pieceLength <= 0 ||
    pieceLength > 2147483647 ||
    tags.length !== 1 ||
    !validEntityTag(tags[0]) ||
    encoding.length !== 1 ||
    encoding[0] !== 'identity' ||
    params.cookies?.length
  )
    throw invalid()
  const receipt = await checkpoint.reconcile(context)
  if (receipt.status !== 'created' || receipt.engineTaskId !== params.gid)
    throw invalid()
  Object.assign(options, fixedOptions, {
    dir: legacyWirePath(params.saveDir),
    out: params.filename,
    gid: params.gid,
    pause: 'true',
    // One range at a time also limits pressure while safely reusing sparse blocks.
    split: '1',
    'max-connection-per-server': '1',
    'piece-length': String(pieceLength),
    'no-proxy': params.noProxy ?? '',
  })
  if (!params.proxy?.trim()) {
    options['all-proxy'] = ''
    options['all-proxy-user'] = ''
    options['all-proxy-passwd'] = ''
  }
  const headers = Array.isArray(options.header) ? [...options.header] : []
  if (!headerValues(headers, 'cookie').length) headers.push('Cookie: ')
  options.header = headers
}

/** Never infer ownership from GID or checkpoint receipt alone. */
export async function verifyLegacyHttpBinding(
  rpc: Pick<Aria2RpcClient, 'tellStatus' | 'getOption'>,
  input: LegacyHttpBindingProof
): Promise<boolean> {
  try {
    const [raw, rawOptions, stat, canonical] = await Promise.all([
      rpc.tellStatus(input.engineTaskId),
      rpc.getOption(input.engineTaskId),
      lstat(input.targetPath, { bigint: true }),
      realpath(input.targetPath),
    ])
    const options = rawOptions as unknown as EngineTaskOptions
    const files = raw.files ?? []
    const expectedUri = admitDownloadSources([input.uri], 'engine')[0]
      .requestUrl
    const tags = headerValues(options.header, 'if-match')
    const encoding = headerValues(options.header, 'accept-encoding')
    return (
      raw.gid === input.engineTaskId &&
      !raw.bittorrent &&
      canonical === input.targetPath &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1n &&
      String(stat.dev) === input.fileIdentity.device &&
      String(stat.ino) === input.fileIdentity.inode &&
      files.length === 1 &&
      files[0].path === legacyWirePath(input.targetPath) &&
      files[0].uris.length > 0 &&
      files[0].uris.every((source) => source.uri === expectedUri) &&
      (Number(raw.totalLength) === 0 ||
        Number(raw.totalLength) === input.expected.totalBytes) &&
      (Number(files[0].length) === 0 ||
        Number(files[0].length) === input.expected.totalBytes) &&
      options.dir === legacyWirePath(input.saveDir) &&
      options.out === path.basename(input.targetPath) &&
      Number(options['piece-length']) === input.expected.pieceBytes &&
      Object.entries(fixedOptions).every(
        ([key, value]) => (options[key] ?? '') === value
      ) &&
      tags.length === 1 &&
      tags[0] === input.entityTag &&
      validEntityTag(input.entityTag) &&
      encoding.length === 1 &&
      encoding[0] === 'identity' &&
      requestMatches(options, input)
    )
  } catch {
    return false
  }
}
