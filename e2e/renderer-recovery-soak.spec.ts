import { appendFile } from 'node:fs/promises'
import { Queries } from '../src/shared/protocol/queries'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

const minutes = Number(process.env.MOTRIX_RENDERER_SOAK_MINUTES ?? 0)

test('renderer longevity across repeated background and foreground cycles', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  test.skip(
    minutes === 0,
    'Set MOTRIX_RENDERER_SOAK_MINUTES to run the longevity check'
  )
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 72 * 60)
    throw new Error('Soak duration must be 1–4320 minutes')
  test.setTimeout(minutes * 60_000 + 90_000)
  await waitForEngineReady(mainWindow)
  await electronApp.evaluate(({ dialog }) => {
    Reflect.set(globalThis, 'rendererSoakPrompts', 0)
    const original = dialog.showMessageBox.bind(dialog)
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as { buttons?: string[] }
      if (options.buttons?.includes('Recover interface')) {
        Reflect.set(
          globalThis,
          'rendererSoakPrompts',
          Number(Reflect.get(globalThis, 'rendererSoakPrompts')) + 1
        )
        return Promise.resolve({ response: 0, checkboxChecked: false })
      }
      return Reflect.apply(original, dialog, args)
    }) as typeof dialog.showMessageBox
  })
  const output = testInfo.outputPath('renderer-soak.jsonl')
  const started = Date.now()
  let cycles = 0
  while (Date.now() - started < minutes * 60_000) {
    await electronApp.evaluate(
      ({ BrowserWindow }, minimize) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes('w=main')
        )
        if (!win) throw new Error('Main window missing during soak')
        if (minimize) win.minimize()
        else win.hide()
      },
      cycles % 2 === 0
    )
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    const metrics = await electronApp.evaluate(({ BrowserWindow, app }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('w=main')
      )
      if (!win) throw new Error('Main window missing during soak')
      if (win.isMinimized()) win.restore()
      win.showInactive()
      return app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
        pid,
        type,
        cpu: cpu.percentCPUUsage,
        memoryKiB: memory.workingSetSize,
      }))
    })
    await expect(
      mainWindow.getByRole('button', { name: 'New task' })
    ).toBeVisible()
    await expect(mainWindow.locator('#renderer-recovery')).toHaveCount(0)
    const session = (await mainWindow.evaluate(
      async (query) => window.motrix?.invoke(query),
      Queries.GetRendererSession
    )) as { generation: string }
    await appendFile(
      output,
      `${JSON.stringify({ elapsedMs: Date.now() - started, cycle: cycles++, generation: session.generation, metrics })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  expect(
    await electronApp.evaluate(() =>
      Reflect.get(globalThis, 'rendererSoakPrompts')
    )
  ).toBe(0)
  await testInfo.attach('renderer-soak', {
    path: output,
    contentType: 'application/x-ndjson',
  })
})
