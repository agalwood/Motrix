import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

export class OperatorTokenInputError extends Error {
  constructor(readonly reason: 'ttyRequired' | 'cancelled' | 'invalid') {
    super(reason)
  }
}

/** Read without echoing the credential or placing it in command arguments. */
export async function readOperatorSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new OperatorTokenInputError('ttyRequired')
  }
  const output = new Writable({ write: (_chunk, _encoding, done) => done() })
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  reader.on('SIGINT', cancel)
  reader.on('SIGTSTP', cancel)
  reader.on('close', cancel)
  for (const signal of ['SIGTERM', 'SIGHUP'] as const)
    process.on(signal, cancel)
  process.stderr.write(`${prompt} `)
  try {
    return await reader.question('', { signal: controller.signal })
  } catch {
    throw new OperatorTokenInputError('cancelled')
  } finally {
    reader.close()
    output.destroy()
    for (const signal of ['SIGTERM', 'SIGHUP'] as const)
      process.off(signal, cancel)
    process.stderr.write('\n')
  }
}

export async function readOperatorTokenStdin(): Promise<string> {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    data += chunk
    if (data.length > 4096) throw new OperatorTokenInputError('invalid')
  }
  // A single terminating line ending is the CLI delimiter, not token content.
  return data.replace(/\r?\n$/, '')
}
