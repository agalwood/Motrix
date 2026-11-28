import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DownloadTask } from '@shared/types/task'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

test('retry parameters create a fresh download and preserve the failed task and partial files', async ({
  mainWindow,
  userDataDir,
}, testInfo) => {
  const payload = Buffer.alloc(16_384, 'new download')
  let authorizedRequests = 0
  const server = createServer((request, response) => {
    if (request.url !== '/archive.zip') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== 'Bearer current-token') {
      response.writeHead(401).end()
      return
    }
    authorizedRequests++
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
    })
    response.end(payload)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const saveDir = path.join(userDataDir, 'downloads')
    await mkdir(saveDir, { recursive: true })
    await waitForEngineReady(mainWindow)
    await mainWindow.evaluate(
      ({ channel, saveDir, url }) =>
        window.motrix.invoke(channel, {
          type: 'http',
          uris: [url],
          saveDir,
          filename: 'archive.zip',
          headers: [{ name: 'Authorization', value: 'Bearer expired-token' }],
        }),
      { channel: Commands.CreateTask, saveDir, url: `${baseUrl}/missing.zip` }
    )
    const readTasks = async () =>
      (await mainWindow.evaluate(
        (channel) => window.motrix.invoke(channel),
        Queries.ListTasks
      )) as DownloadTask[]
    await expect.poll(async () => (await readTasks())[0]?.status).toBe('error')
    const original = (await readTasks())[0]
    expect(original.diskPath).toBe(path.join(saveDir, 'archive.zip.motrix'))
    // Retained artifacts model an interrupted download. Re-download must never
    // reuse either artifact, even when the requested filename stays unchanged.
    const partial = Buffer.from('original partial bytes')
    const checkpoint = Buffer.from('original control file')
    await writeFile(original.diskPath, partial)
    await writeFile(`${original.diskPath}.aria2`, checkpoint)

    await mainWindow
      .getByRole('link', { name: 'Downloads', exact: true })
      .click()
    await mainWindow.locator(`[data-task-id="${original.id}"]`).dblclick()
    await mainWindow
      .getByRole('button', { name: 'Retry', exact: true })
      .first()
      .click()
    const dialog = mainWindow.getByRole('dialog', { name: 'Retry download' })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(/The failed task and its partial file will be kept/)
    ).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'URLs' })).toHaveValue(
      `${baseUrl}/missing.zip`
    )
    await expect(dialog.getByLabel('Authorization')).toHaveValue('')
    await expect(dialog.getByLabel('Filename')).toHaveValue('archive.zip')
    await mainWindow.screenshot({
      path: testInfo.outputPath('retry-parameters-dialog.png'),
    })
    await mainWindow.setViewportSize({ width: 960, height: 600 })
    await expect(
      dialog.getByRole('button', { name: 'Re-download' })
    ).toBeInViewport()
    await dialog.getByLabel('Authorization').scrollIntoViewIfNeeded()
    await expect(dialog.getByLabel('Authorization')).toBeInViewport()
    await mainWindow.screenshot({
      path: testInfo.outputPath('retry-parameters-short.png'),
    })

    await dialog
      .getByRole('textbox', { name: 'URLs' })
      .fill(`${baseUrl}/archive.zip`)
    await dialog.getByLabel('Authorization').fill('Bearer current-token')
    await dialog.getByRole('button', { name: 'Re-download' }).click()
    await expect(dialog).not.toBeVisible()
    await expect
      .poll(
        async () =>
          (await readTasks()).find((task) => task.id !== original.id)?.status
      )
      .toBe('completed')
    const tasks = await readTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks.find((task) => task.id === original.id)).toMatchObject({
      status: 'error',
      diskPath: original.diskPath,
      finalName: original.finalName,
    })
    const replacement = tasks.find((task) => task.id !== original.id)!
    expect(replacement.finalName).toBe('archive (1).zip')
    expect(await readFile(replacement.finalPath)).toEqual(payload)
    expect(await readFile(original.diskPath)).toEqual(partial)
    expect(await readFile(`${original.diskPath}.aria2`)).toEqual(checkpoint)
    expect(authorizedRequests).toBeGreaterThan(0)
    expect(JSON.stringify(tasks)).not.toContain('current-token')
    expect(JSON.stringify(tasks)).not.toContain('expired-token')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})
