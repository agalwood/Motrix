import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { redactLogText } from '@core/log-redact'

const MAX_LINE_LENGTH = 32 * 1024
const OMITTED_LINE = '[aria2 output line omitted: exceeds 32768 characters]'
const LOG_HEADER =
  /^(?:\d{2}\/\d{2} \d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?) \[(DEBUG|INFO|NOTICE|WARN|ERROR)\]/
const EXCEPTION_LINE = /^\s*(?:Exception:|->)/
const SENSITIVE_HEADER =
  /\b((?:Proxy-)?Authorization|(?:Set-)?Cookie|Referer|X-[\w-]+|[\w-]*(?:Token|Secret|Credential|Api-Key))\s*:.*/i

type OutputLevel = 'debug' | 'info' | 'warn' | 'error'
type OutputStream = 'stdout' | 'stderr'

export interface Aria2OutputRecord {
  level: OutputLevel
  message: string
  fields: {
    stream: OutputStream
    data: string
    cuid?: string
    aria2ErrorCode?: number
    httpStatus?: number
  }
}

interface ExceptionContext {
  level: OutputLevel
  cuid?: string
  aria2ErrorCode?: number
}

/** Read complete lines before classification or redaction, including split UTF-8. */
export class Aria2ProcessOutput {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private droppingLine = false
  private previousWasCr = false
  private ended = false
  private context: ExceptionContext | undefined
  private redactedHeader = false
  private httpHeaders = false

  constructor(
    private readonly stream: OutputStream,
    private readonly emit: (record: Aria2OutputRecord) => void,
    private readonly redactKnownSecrets: (text: string) => string
  ) {}

  write(chunk: Buffer): void {
    if (!this.ended) this.consume(this.decoder.write(chunk))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.consume(this.decoder.end())
    if (this.droppingLine) this.emitOmittedLine()
    else if (this.pending) this.emitLine(this.pending)
    this.pending = ''
    this.context = undefined
  }

  private consume(text: string): void {
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
      // Treat CRLF as one separator even across chunks; standalone carriage
      // returns delimit progress output without growing an unbounded line.
      if (text[index] === '\n' && this.previousWasCr) {
        this.previousWasCr = false
        start = index + 1
        continue
      }
      this.previousWasCr = text[index] === '\r'
      if (text[index] !== '\n' && text[index] !== '\r') continue
      this.append(text.slice(start, index))
      if (this.droppingLine) this.emitOmittedLine()
      else this.emitLine(this.pending)
      this.pending = ''
      this.droppingLine = false
      start = index + 1
    }
    this.append(text.slice(start))
  }

  private append(text: string): void {
    if (this.droppingLine) return
    if (this.pending.length + text.length > MAX_LINE_LENGTH) {
      // Never emit an arbitrary prefix/suffix: it may split a credential.
      this.pending = ''
      this.droppingLine = true
      return
    }
    this.pending += text
  }

  private emitOmittedLine(): void {
    this.emit({
      level: this.context?.level ?? 'warn',
      message: 'aria2 output truncated',
      fields: { stream: this.stream, data: OMITTED_LINE },
    })
    this.context = undefined
    this.redactedHeader = false
    this.httpHeaders = false
  }

  private emitLine(raw: string): void {
    const line = stripVTControlCharacters(raw)
    if (!line.trim()) {
      this.context = undefined
      this.redactedHeader = false
      this.httpHeaders = false
      return
    }
    const data = this.sanitize(line)
    const header = LOG_HEADER.exec(data)
    const continuation = EXCEPTION_LINE.test(data)
    if (!continuation) this.context = undefined

    let level: OutputLevel = this.stream === 'stderr' ? 'warn' : 'debug'
    if (header?.[1] === 'ERROR') level = 'error'
    else if (header?.[1] === 'WARN') level = 'warn'
    else if (continuation) level = this.context?.level ?? 'error'

    const cuid = /\bCUID#(\d{1,20})\b/.exec(data)?.[1] ?? this.context?.cuid
    const code = continuation
      ? /\berrorCode=(\d{1,3})\b/.exec(data)?.[1]
      : undefined
    const aria2ErrorCode = code ? Number(code) : this.context?.aria2ErrorCode
    const httpStatus = continuation
      ? /\bstatus=([1-5]\d{2})\b/.exec(data)?.[1]
      : undefined
    if (header || continuation) {
      this.context = { level, cuid, aria2ErrorCode }
    }

    const rpcDiagnostic = data.includes('RPC-DIAG')
    this.emit({
      level: rpcDiagnostic && level === 'debug' ? 'info' : level,
      message: rpcDiagnostic
        ? 'aria2 RPC diagnostic'
        : level === 'error' || level === 'warn'
          ? 'aria2 engine diagnostic'
          : `aria2 ${this.stream}`,
      fields: {
        stream: this.stream,
        data,
        ...(cuid ? { cuid } : {}),
        ...(aria2ErrorCode === undefined ? {} : { aria2ErrorCode }),
        ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}),
      },
    })
  }

  private sanitize(line: string): string {
    if (
      this.redactedHeader &&
      /^\s+\S/.test(line) &&
      !EXCEPTION_LINE.test(line)
    ) {
      return '[redacted header continuation]'
    }
    // Debug-enabled engines can print raw HTTP messages. Their request target
    // and arbitrary header values are not safe diagnostic fields.
    const request =
      /^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH|CONNECT) \S+ (HTTP\/\d(?:\.\d)?)$/.exec(
        line
      )
    if (request || /^HTTP\/\d(?:\.\d)? \d{3}\b/.test(line)) {
      this.httpHeaders = true
      this.redactedHeader = false
      return request ? `${request[1]} [redacted] ${request[2]}` : line
    }
    const header = /^\s*([!#$%&'*+.^_`|~\w-]+):/.exec(line)
    if (this.httpHeaders && header) {
      this.redactedHeader = true
      return `${header[1]}: [redacted]`
    }
    this.httpHeaders = false
    this.redactedHeader = SENSITIVE_HEADER.test(line)
    const text = this.redactKnownSecrets(line).replace(
      SENSITIVE_HEADER,
      '$1: [redacted]'
    )
    // Signed cloud URLs can put credentials in paths or arbitrary query keys.
    // The origin is sufficient to identify the failing provider in this log.
    return redactLogText(
      text.replace(/\b(?:https?|ftp|sftp|wss?):\/\/[^\s<>"`]+/gi, (rawUrl) => {
        try {
          const url = new URL(rawUrl)
          return `${url.protocol}//${url.host}/[redacted]`
        } catch {
          return '[redacted-url]'
        }
      }),
      true
    )
  }
}
