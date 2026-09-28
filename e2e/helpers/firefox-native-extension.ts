import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { firefox } from '@playwright/test'
import WebSocket from 'ws'
import { getFreePort } from './free-port'

export interface ExtensionPage {
  evaluate<R, A = undefined>(
    fn: (arg: A) => R | Promise<R>,
    arg?: A
  ): Promise<R>
}

/** Firefox's native BiDi installer exercises the actual installed extension. */
export async function launchNativeFirefox(input: {
  profile: string
  extension: string
  env: NodeJS.ProcessEnv
}): Promise<{ page: ExtensionPage; close(): Promise<void> }> {
  const uuid = 'fbff0d6e-e992-42ed-b009-a07a0bf86f7d'
  await writeFile(
    join(input.profile, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'motrix-extension@motrix.app': uuid }))});`,
      'user_pref("intl.locale.requested", "en-US");',
    ].join('\n')
  )
  const port = await getFreePort()
  const process = spawn(
    firefox.executablePath(),
    [
      '--headless',
      '--no-remote',
      '--profile',
      input.profile,
      '--remote-debugging-port',
      String(port),
      '--remote-allow-system-access',
    ],
    { env: input.env, stdio: 'ignore' }
  )
  let socket: WebSocket | undefined
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  let sequence = 0
  const close = async () => {
    socket?.close()
    for (const request of pending.values())
      request.reject(new Error('Firefox closed'))
    if (process.exitCode === null) {
      process.kill('SIGTERM')
      await new Promise<void>((resolve) =>
        process.once('exit', () => resolve())
      )
    }
  }
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !socket) {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`)
      const opened = await new Promise<boolean>((resolve) => {
        candidate.once('open', () => resolve(true))
        candidate.once('error', () => resolve(false))
      })
      if (opened) socket = candidate
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!socket) throw new Error('Firefox BiDi did not start')
    socket.on('message', (data) => {
      const response = JSON.parse(String(data)) as {
        id: number
        type: string
        result?: unknown
      }
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id)
      if (response.type === 'error')
        request.reject(new Error('Firefox BiDi command failed'))
      else request.resolve(response.result)
    })
    const command = (method: string, params: unknown): Promise<unknown> => {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Firefox ${method} timed out`))
        }, 20_000)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
        })
        socket?.send(JSON.stringify({ id, method, params }))
      })
    }
    await command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    })
    await command('webExtension.install', {
      extensionData: { type: 'path', path: input.extension },
    })
    const tree = (await command('browsingContext.getTree', {})) as {
      contexts: { context: string }[]
    }
    const context = tree.contexts[0]?.context
    if (!context) throw new Error('Firefox did not expose a browsing context')
    await command('browsingContext.navigate', {
      context,
      url: `moz-extension://${uuid}/options.html`,
      wait: 'complete',
    })
    return {
      close,
      page: {
        async evaluate<R, A = undefined>(
          fn: (arg: A) => R | Promise<R>,
          arg?: A
        ): Promise<R> {
          // Serialize only the result to avoid depending on BiDi's nested
          // RemoteValue representation. Exception details can contain secrets.
          const response = (await command('script.evaluate', {
            expression: `(async () => JSON.stringify(await (${fn.toString()})(${JSON.stringify(arg)})))()`,
            target: { context },
            awaitPromise: true,
            resultOwnership: 'none',
          })) as { type: string; result?: { value?: string } }
          if (response.type !== 'success')
            throw new Error('Firefox extension evaluation failed')
          return (
            response.result?.value === undefined
              ? undefined
              : JSON.parse(response.result.value)
          ) as R
        },
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
