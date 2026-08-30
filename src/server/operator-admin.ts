import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  FALLBACK_LOCALE,
  resolveSupportedLocale,
  SUPPORTED_LOCALE_CODES,
} from '@shared/constants/locales'
import { I18N_RESOURCES } from '@shared/i18n-resources'
import {
  BridgeCommands,
  BridgeQueries,
  type PendingPairRequestInfo,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import { createInstance } from 'i18next'
import { z } from 'zod'
import { parseServerPort } from './environment'

const OPERATOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/
const USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/
const WIRE_USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
const DEFAULT_DATA_DIR = '/data'
const DEFAULT_PORT = 8080
const PENDING_RETRY_WINDOW_MS = 5_000
const PENDING_RETRY_DELAY_MS = 250
const MUTATION_TIMEOUT_MS = 5_000
const MAX_PENDING_ATTEMPTS = 32
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CLIENT_NAME_LENGTH = 80
const MAX_CLIENT_VERSION_LENGTH = 32

type PendingCliRequest = Extract<PendingPairRequestInfo, { kind: 'cli' }>
type PendingExtensionRequest = Extract<
  PendingPairRequestInfo,
  { kind: 'extension' }
>
type Translate = (
  key: string,
  values?: Readonly<Record<string, string | number>>
) => string

const pendingCliRequestSchema: z.ZodType<PendingCliRequest> = z
  .object({
    kind: z.literal('cli'),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    userCode: z.string().regex(WIRE_USER_CODE_PATTERN),
    clientName: z.string().min(1).max(200),
    clientVersion: z.string().max(64),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()

const pendingExtensionRequestSchema: z.ZodType<PendingExtensionRequest> = z
  .object({
    kind: z.literal('extension'),
    pairingNonce: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    extensionId: z.string().min(1).max(256),
    browser: z.enum(['chromium', 'firefox']),
    identity: z.enum(['official', 'attested-non-official', 'unverified']),
    code: z.string().regex(WIRE_USER_CODE_PATTERN),
    verifiedOrigin: z.string().min(1).max(512).optional(),
    originHost: z.string().min(1).max(256).optional(),
    claimedExtensionId: z.string().min(1).max(256).optional(),
    attestationClass: z
      .enum(['official', 'attested-non-official', 'unverified'])
      .optional(),
    publicAuthority: z.string().min(1).max(512).optional(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()

const pendingPairRequestSchema: z.ZodType<PendingPairRequestInfo> = z.union([
  pendingCliRequestSchema,
  pendingExtensionRequestSchema,
])

const pendingResponseSchema: z.ZodType<PendingPairRequestInfo[]> = z
  .array(pendingPairRequestSchema)
  .max(1_000)

const resolvePairResultSchema: z.ZodType<ResolvePairResult> =
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }).strict(),
    z
      .object({ ok: z.literal(false), reason: z.literal('unavailable') })
      .strict(),
  ])

const unknownChannelResponseSchema = z
  .object({ error: z.literal('unknown channel') })
  .strict()

export enum OperatorAdminExitCode {
  Success = 0,
  Usage = 2,
  Unavailable = 3,
  Credential = 4,
  Server = 5,
}

enum OperatorAdminErrorKind {
  Usage = 'usage',
  Unavailable = 'unavailable',
  Credential = 'credential',
  Server = 'server',
}

enum OperatorAdminErrorCode {
  JsonRepeated = 'usage.jsonRepeated',
  UnknownOption = 'usage.unknownOption',
  PairingCommandRequired = 'usage.pairingCommandRequired',
  PairingOperationRequired = 'usage.pairingOperationRequired',
  PairingCodeInvalid = 'usage.pairingCodeInvalid',
  PortInvalid = 'usage.portInvalid',
  TokenHeaderInvalid = 'credential.tokenHeaderInvalid',
  DataDirNotAbsolute = 'credential.dataDirNotAbsolute',
  CredentialUnavailable = 'credential.unavailable',
  CredentialNotFile = 'credential.notFile',
  CredentialUnreadable = 'credential.unreadable',
  CredentialInvalid = 'credential.invalid',
  CredentialRejected = 'credential.rejected',
  ResponseUnreadable = 'server.responseUnreadable',
  ResponseOversized = 'server.responseOversized',
  ResponseInvalidJson = 'server.responseInvalidJson',
  RpcHttp = 'server.rpcHttp',
  ApprovalUnavailable = 'server.approvalUnavailable',
  PendingResponseInvalid = 'server.pendingResponseInvalid',
  DecisionOutcomeUnknown = 'server.decisionOutcomeUnknown',
  DecisionResponseInvalid = 'server.decisionResponseInvalid',
  RequestNoLongerPending = 'server.requestNoLongerPending',
  NoMatchingRequest = 'server.noMatchingRequest',
  AmbiguousRequest = 'server.ambiguousRequest',
  Unexpected = 'server.unexpected',
  LoopbackUnavailable = 'unavailable.loopback',
  ApprovalNotReady = 'unavailable.approvalNotReady',
}

interface ErrorInterpolation {
  [key: string]: string | number
}

class OperatorAdminError extends Error {
  constructor(
    readonly kind: OperatorAdminErrorKind,
    readonly code: OperatorAdminErrorCode,
    readonly values: ErrorInterpolation = {}
  ) {
    super(code)
    this.name = 'OperatorAdminError'
  }
}

interface OperatorAdminDependencies {
  env: NodeJS.ProcessEnv
  fetch: typeof globalThis.fetch
  lstat: typeof lstat
  readFile: typeof readFile
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  writeStdout: (message: string) => void
  writeStderr: (message: string) => void
  pendingRetryWindowMs: number
  mutationTimeoutMs: number
}

export interface OperatorAdminOptions
  extends Partial<OperatorAdminDependencies> {}

interface ParsedCommand {
  json: boolean
  operation: 'pending' | 'approve' | 'deny'
  userCode?: string
}

interface ProjectedPairRequest {
  userCode: string
  clientName: string
  clientVersion: string
  createdAt: number
  expiresAt: number
}

function defaultDependencies(
  options: OperatorAdminOptions
): OperatorAdminDependencies {
  return {
    env: options.env ?? process.env,
    fetch: options.fetch ?? fetch.bind(globalThis),
    lstat: options.lstat ?? lstat,
    readFile: options.readFile ?? readFile,
    now: options.now ?? Date.now,
    sleep:
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    writeStdout:
      options.writeStdout ??
      ((message) => {
        process.stdout.write(`${message}\n`)
      }),
    writeStderr:
      options.writeStderr ??
      ((message) => {
        process.stderr.write(`${message}\n`)
      }),
    pendingRetryWindowMs:
      options.pendingRetryWindowMs ?? PENDING_RETRY_WINDOW_MS,
    mutationTimeoutMs: options.mutationTimeoutMs ?? MUTATION_TIMEOUT_MS,
  }
}

async function createTranslator(env: NodeJS.ProcessEnv): Promise<Translate> {
  const locale = resolveSupportedLocale(env.MOTRIX_HOST_LANGUAGE, env.LANG)
  const instance = createInstance()
  await instance.init({
    resources: I18N_RESOURCES,
    supportedLngs: SUPPORTED_LOCALE_CODES,
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    interpolation: {
      escapeValue: false,
    },
  })
  const fixedT = instance.getFixedT(locale)
  return (key, values) => String(fixedT(key, values))
}

function exitCodeFor(error: OperatorAdminError): OperatorAdminExitCode {
  switch (error.kind) {
    case OperatorAdminErrorKind.Usage:
      return OperatorAdminExitCode.Usage
    case OperatorAdminErrorKind.Unavailable:
      return OperatorAdminExitCode.Unavailable
    case OperatorAdminErrorKind.Credential:
      return OperatorAdminExitCode.Credential
    case OperatorAdminErrorKind.Server:
      return OperatorAdminExitCode.Server
  }
}

function parseCommand(argv: readonly string[]): ParsedCommand | 'help' {
  const jsonCount = argv.filter((arg) => arg === '--json').length
  const json = jsonCount > 0
  if (jsonCount > 1) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.JsonRepeated
    )
  }

  if (
    argv.length === 0 ||
    argv.includes('--help') ||
    argv.includes('-h') ||
    (argv.length === 1 && argv[0] === 'help')
  ) {
    return 'help'
  }

  const args = argv.filter((arg) => arg !== '--json')
  if (args.some((arg) => arg.startsWith('--'))) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.UnknownOption
    )
  }
  if (args[0] !== 'pairing') {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.PairingCommandRequired
    )
  }

  const operation = args[1]
  if (operation === 'pending' && args.length === 2) {
    return { json, operation }
  }
  if ((operation === 'approve' || operation === 'deny') && args.length >= 3) {
    return {
      json,
      operation,
      userCode: normalizeUserCode(args.slice(2).join('')),
    }
  }
  throw new OperatorAdminError(
    OperatorAdminErrorKind.Usage,
    OperatorAdminErrorCode.PairingOperationRequired
  )
}

export function normalizeUserCode(input: string): string {
  const stripped = input.replace(/[\t\n\v\f\r -]/g, '')
  if ([...stripped].some((character) => character.charCodeAt(0) > 0x7f)) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.PairingCodeInvalid
    )
  }
  const normalized = stripped.toUpperCase()
  if (!USER_CODE_PATTERN.test(normalized)) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.PairingCodeInvalid
    )
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

async function readOperatorToken(
  deps: OperatorAdminDependencies
): Promise<string> {
  const fromEnvironment = deps.env.MOTRIX_OPERATOR_TOKEN
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) {
    if (/[\r\n\0]/.test(fromEnvironment)) {
      throw new OperatorAdminError(
        OperatorAdminErrorKind.Credential,
        OperatorAdminErrorCode.TokenHeaderInvalid
      )
    }
    return fromEnvironment
  }

  const dataDir = deps.env.MOTRIX_DATA_DIR || DEFAULT_DATA_DIR
  if (!isAbsolute(dataDir)) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.DataDirNotAbsolute
    )
  }
  const tokenPath = join(dataDir, 'operator-token')
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await deps.lstat(tokenPath)
  } catch {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.CredentialUnavailable
    )
  }
  if (!metadata.isFile()) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.CredentialNotFile
    )
  }

  let token: string
  try {
    token = await deps.readFile(tokenPath, 'utf8')
  } catch {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.CredentialUnreadable
    )
  }
  if (!OPERATOR_TOKEN_PATTERN.test(token)) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.CredentialInvalid
    )
  }
  return token
}

function serverBaseUrl(env: NodeJS.ProcessEnv): string {
  let port: number
  try {
    port = parseServerPort(env.PORT, 'PORT', DEFAULT_PORT)
  } catch {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Usage,
      OperatorAdminErrorCode.PortInvalid
    )
  }
  return `http://127.0.0.1:${port}`
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The status is all the caller needs; a failed body cancellation is benign.
  }
}

async function readResponseText(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.ResponseUnreadable
    )
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.ResponseOversized
    )
  }
  return text
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await readResponseText(response)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.ResponseInvalidJson
    )
  }
}

async function isUnknownChannelResponse(response: Response): Promise<boolean> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return false
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return false
  try {
    return unknownChannelResponseSchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}

function requestInit(token: string, args: unknown[]): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ args }),
    cache: 'no-store',
    redirect: 'error',
  }
}

function classifyHttpStatus(status: number, mutation: boolean): never {
  if (status === 401 || status === 403) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Credential,
      OperatorAdminErrorCode.CredentialRejected
    )
  }
  if (status === 404 && mutation) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.ApprovalUnavailable
    )
  }
  throw new OperatorAdminError(
    OperatorAdminErrorKind.Server,
    OperatorAdminErrorCode.RpcHttp,
    { status }
  )
}

function retryWindowExpired(
  deps: OperatorAdminDependencies,
  startedAt: number,
  attempts: number
): boolean {
  return (
    deps.now() - startedAt >= deps.pendingRetryWindowMs ||
    attempts >= MAX_PENDING_ATTEMPTS
  )
}

async function waitBeforePendingRetry(
  deps: OperatorAdminDependencies,
  startedAt: number
): Promise<void> {
  await deps.sleep(
    Math.min(
      PENDING_RETRY_DELAY_MS,
      Math.max(0, deps.pendingRetryWindowMs - (deps.now() - startedAt))
    )
  )
}

async function listPendingRequests(
  deps: OperatorAdminDependencies,
  baseUrl: string,
  token: string
): Promise<PendingCliRequest[]> {
  const startedAt = deps.now()
  let attempts = 0
  while (attempts < MAX_PENDING_ATTEMPTS) {
    attempts += 1
    const elapsed = Math.max(0, deps.now() - startedAt)
    const remaining = Math.max(1, deps.pendingRetryWindowMs - elapsed)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remaining)
    let response: Response
    try {
      response = await deps.fetch(
        `${baseUrl}/rpc/query/${encodeURIComponent(
          BridgeQueries.ListPendingPairRequests
        )}`,
        {
          ...requestInit(token, []),
          signal: controller.signal,
        }
      )
    } catch {
      if (retryWindowExpired(deps, startedAt, attempts)) {
        throw new OperatorAdminError(
          OperatorAdminErrorKind.Unavailable,
          OperatorAdminErrorCode.LoopbackUnavailable
        )
      }
      await waitBeforePendingRetry(deps, startedAt)
      continue
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 404) {
      const isStartupResponse = await isUnknownChannelResponse(response)
      if (!isStartupResponse) classifyHttpStatus(response.status, false)
      if (retryWindowExpired(deps, startedAt, attempts)) {
        throw new OperatorAdminError(
          OperatorAdminErrorKind.Unavailable,
          OperatorAdminErrorCode.ApprovalNotReady
        )
      }
      await waitBeforePendingRetry(deps, startedAt)
      continue
    }
    if (!response.ok) {
      await discardResponse(response)
      classifyHttpStatus(response.status, false)
    }

    const parsed = pendingResponseSchema.safeParse(
      await parseJsonResponse(response)
    )
    if (!parsed.success) {
      throw new OperatorAdminError(
        OperatorAdminErrorKind.Server,
        OperatorAdminErrorCode.PendingResponseInvalid
      )
    }
    // `motrix-admin` is intentionally CLI-only: Extension pairing approval is
    // code-entry in the browser, not an operator allow/deny action. Validate
    // the complete renderer-safe union first so a malformed Server response
    // still fails closed, then project only CLI rows. In particular, never
    // print or match an Extension's PAKE code.
    return parsed.data.filter(
      (request): request is PendingCliRequest => request.kind === 'cli'
    )
  }

  throw new OperatorAdminError(
    OperatorAdminErrorKind.Unavailable,
    OperatorAdminErrorCode.ApprovalNotReady
  )
}

async function resolvePairRequest(
  deps: OperatorAdminDependencies,
  baseUrl: string,
  token: string,
  params: ResolvePairParams
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.mutationTimeoutMs)
  try {
    const response = await deps.fetch(
      `${baseUrl}/rpc/command/${encodeURIComponent(
        BridgeCommands.ResolvePair
      )}`,
      {
        ...requestInit(token, [params]),
        signal: controller.signal,
      }
    )
    if (!response.ok) {
      await discardResponse(response)
      classifyHttpStatus(response.status, true)
    }
    const parsed = resolvePairResultSchema.safeParse(
      await parseJsonResponse(response)
    )
    if (!parsed.success) {
      throw new OperatorAdminError(
        OperatorAdminErrorKind.Server,
        OperatorAdminErrorCode.DecisionResponseInvalid
      )
    }
    if (!parsed.data.ok) {
      throw new OperatorAdminError(
        OperatorAdminErrorKind.Server,
        OperatorAdminErrorCode.RequestNoLongerPending
      )
    }
  } catch (error) {
    if (error instanceof OperatorAdminError) throw error
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.DecisionOutcomeUnknown
    )
  } finally {
    clearTimeout(timeout)
  }
}

function findUniqueRequest(
  requests: readonly PendingCliRequest[],
  userCode: string
): PendingCliRequest {
  const matches = requests.filter((request) => request.userCode === userCode)
  if (matches.length === 0) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.NoMatchingRequest,
      { userCode }
    )
  }
  if (matches.length !== 1) {
    throw new OperatorAdminError(
      OperatorAdminErrorKind.Server,
      OperatorAdminErrorCode.AmbiguousRequest,
      { userCode }
    )
  }
  return matches[0] as PendingCliRequest
}

function safeOutputText(value: string, maximum: number): string {
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const limited = [...cleaned].slice(0, maximum).join('')
  return limited || '-'
}

function projectRequest(request: PendingCliRequest): ProjectedPairRequest {
  return {
    userCode: request.userCode,
    clientName: safeOutputText(request.clientName, MAX_CLIENT_NAME_LENGTH),
    clientVersion: safeOutputText(
      request.clientVersion,
      MAX_CLIENT_VERSION_LENGTH
    ),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  }
}

function formatTtl(t: Translate, expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  return t('operatorAdmin.pending.ttl', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  })
}

function printPending(
  deps: OperatorAdminDependencies,
  t: Translate,
  requests: readonly PendingCliRequest[],
  json: boolean
): void {
  const sorted = [...requests].sort(
    (left, right) => left.createdAt - right.createdAt
  )
  const projected = sorted.map(projectRequest)
  if (json) {
    deps.writeStdout(JSON.stringify({ ok: true, requests: projected }))
    return
  }
  if (projected.length === 0) {
    deps.writeStdout(t('operatorAdmin.pending.none'))
    return
  }
  for (const request of projected) {
    deps.writeStdout(
      t('operatorAdmin.pending.row', {
        userCode: request.userCode,
        clientName: request.clientName,
        clientVersion: request.clientVersion,
        ttl: formatTtl(t, request.expiresAt, deps.now()),
      })
    )
  }
}

function printDecision(
  deps: OperatorAdminDependencies,
  t: Translate,
  request: PendingCliRequest,
  operation: 'approve' | 'deny',
  json: boolean
): void {
  const projected = projectRequest(request)
  if (json) {
    deps.writeStdout(
      JSON.stringify({
        ok: true,
        action: operation,
        request: projected,
      })
    )
    return
  }
  deps.writeStdout(
    t(`operatorAdmin.decision.${operation}`, {
      userCode: projected.userCode,
      clientName: projected.clientName,
      clientVersion: projected.clientVersion,
    })
  )
}

function printError(
  deps: OperatorAdminDependencies,
  t: Translate,
  error: OperatorAdminError,
  json: boolean
): void {
  const message = safeOutputText(
    t(`operatorAdmin.errors.${error.code}`, error.values),
    240
  )
  if (json) {
    deps.writeStderr(
      JSON.stringify({
        ok: false,
        error: { code: error.code, kind: error.kind, message },
      })
    )
    return
  }
  deps.writeStderr(t('operatorAdmin.errorPrefix', { message }))
  if (error.kind === OperatorAdminErrorKind.Usage) {
    deps.writeStderr(t('operatorAdmin.usageHint'))
  }
}

export async function runOperatorAdmin(
  argv: readonly string[],
  options: OperatorAdminOptions = {}
): Promise<OperatorAdminExitCode> {
  const deps = defaultDependencies(options)
  const t = await createTranslator(deps.env)
  let json = argv.includes('--json')
  try {
    const command = parseCommand(argv)
    if (command === 'help') {
      deps.writeStdout(t('operatorAdmin.help'))
      return OperatorAdminExitCode.Success
    }
    json = command.json

    const token = await readOperatorToken(deps)
    const baseUrl = serverBaseUrl(deps.env)
    const pending = await listPendingRequests(deps, baseUrl, token)
    if (command.operation === 'pending') {
      printPending(deps, t, pending, command.json)
      return OperatorAdminExitCode.Success
    }

    const request = findUniqueRequest(pending, command.userCode as string)
    const params: ResolvePairParams = {
      kind: 'cli',
      requestId: request.requestId,
      decision: command.operation === 'approve' ? 'allow' : 'deny',
    }
    await resolvePairRequest(deps, baseUrl, token, params)
    printDecision(deps, t, request, command.operation, command.json)
    return OperatorAdminExitCode.Success
  } catch (error) {
    const normalized =
      error instanceof OperatorAdminError
        ? error
        : new OperatorAdminError(
            OperatorAdminErrorKind.Server,
            OperatorAdminErrorCode.Unexpected
          )
    printError(deps, t, normalized, json)
    return exitCodeFor(normalized)
  }
}
