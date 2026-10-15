export interface DiagnosticCheck {
  id: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  detail: string
  durationMs: number
}

export interface ConnectionDiagnosticResult {
  startedAt: string
  durationMs: number
  backend: 'local' | 'remote'
  checks: DiagnosticCheck[]
}

/** A dead background/API must leave the user with a copyable report. */
export async function diagnosticDeadline<T>(
  task: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic check timed out')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Keep browser errors useful without copying URL credentials or query data. */
export function redactDiagnosticError(message: string): string {
  return message
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (text) => {
      try {
        const url = new URL(text)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
      } catch {
        return '[invalid URL omitted]'
      }
    })
    .slice(0, 2048)
}
