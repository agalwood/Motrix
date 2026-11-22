import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import { Commands } from '../../src/shared/protocol/commands'
import { getFreePort } from '../helpers/free-port'
import { renameFilesFlow } from '../helpers/rename-files-flow'

test('renames files through the authenticated Web UI and preserves them after server restart', async ({
  page,
}, info) => {
  test.setTimeout(120000)
  const repo = process.cwd()
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'motrix-web-rename-'))
  )
  const data = path.join(root, 'data'),
    downloads = path.join(root, 'downloads')
  await mkdir(data)
  await mkdir(downloads)
  const port = await getFreePort(),
    rpcPort = await getFreePort(),
    token = randomUUID()
  const base = `http://127.0.0.1:${port}`
  await writeFile(
    path.join(data, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { language: 'en-US', defaultSaveDir: downloads },
      onboarding: { disclaimerAccepted: true },
      tracker: { autoSync: false },
      engine: { rpcPort, dhtEnabled: false, btEnableLpd: false, seedRatio: 0 },
    })
  )
  let child: ChildProcess | undefined
  let exited: Promise<void> | undefined
  let logs = ''
  const stop = async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM')
      await exited
    }
  }
  const launch = async () => {
    child = spawn(
      process.execPath,
      [path.join(repo, 'dist/server/index.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          PORT: String(port),
          MOTRIX_DATA_DIR: data,
          MOTRIX_DEFAULT_SAVE_DIR: downloads,
          MOTRIX_ALLOWED_SAVE_DIRS: downloads,
          MOTRIX_MDXP_PORT: '0',
          MOTRIX_MDXP_HOST: '127.0.0.1',
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'false',
          MOTRIX_PUBLIC_URL: base,
          MOTRIX_OPERATOR_TOKEN: token,
          MOTRIX_TAIJI_BIN: path.join(
            repo,
            'extra',
            process.platform,
            process.arch,
            process.platform === 'win32' ? 'taiji.exe' : 'taiji'
          ),
          MOTRIX_RENDERER_DIR: path.join(repo, 'dist/renderer-web'),
          MOTRIX_BUILTIN_PLUGIN_DIR: path.join(repo, 'dist/builtin-plugins'),
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    child.stdout?.on('data', (chunk) => {
      logs = (logs + chunk.toString()).slice(-32000)
    })
    child.stderr?.on('data', (chunk) => {
      logs = (logs + chunk.toString()).slice(-32000)
    })
    const launched = child
    exited = new Promise((resolve) => launched.once('exit', () => resolve()))
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null) throw new Error(logs)
          try {
            return (await page.request.get(`${base}/healthz`)).ok()
          } catch {
            return false
          }
        },
        { timeout: 25000 }
      )
      .toBe(true)
    expect(
      (
        await page.request.post(`${base}/rpc/auth/login`, {
          data: { token },
          headers: { origin: base },
        })
      ).ok()
    ).toBe(true)
    await page.goto(base)
  }
  try {
    await launch()
    const denied = await fetch(
      `${base}/rpc/command/${encodeURIComponent(Commands.RenameTaskFile)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [{ taskId: 'not-authorized' }] }),
      }
    )
    expect(denied.status).toBe(401)
    await renameFilesFlow({
      page: () => page,
      saveDir: downloads,
      info,
      restart: async () => {
        await stop()
        await launch()
      },
      invoke: async (channel, value) => {
        const response = await page.request.post(
          `${base}/rpc/${channel.startsWith('command:') ? 'command' : 'query'}/${encodeURIComponent(channel)}`,
          {
            data: { args: value === undefined ? [] : [value] },
            headers: { origin: base },
          }
        )
        const result = await response.json()
        if (!response.ok()) throw new Error(JSON.stringify(result))
        return result
      },
    })
  } finally {
    await stop()
    if (info.status !== info.expectedStatus)
      await info.attach('server-log', { body: logs, contentType: 'text/plain' })
    await rm(root, { recursive: true, force: true })
  }
})
