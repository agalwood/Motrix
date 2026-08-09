import {
  expect,
  findAddTaskWindow,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

test.describe('add task', () => {
  test('http url submitted via the add-task window appears in Downloads', async ({
    electronApp,
    mainWindow,
    httpFixture,
  }) => {
    // Engine has to be Ready before we submit — otherwise the IPC
    // handler that bridges to aria2 will reject and the renderer
    // surfaces a toast instead of a row in the list.
    await waitForEngineReady(mainWindow)

    // The trigger sits in the WindowChrome of the main window. Scope
    // the locator to mainWindow so it can't accidentally match the
    // identical-aria-label button inside the add-task window once that
    // window opens.
    await mainWindow.getByRole('button', { name: 'New task' }).click()

    const addTaskPage = await findAddTaskWindow(electronApp)

    // UrlTextarea exposes aria-label="URLs". Use fill() rather than
    // type() — the textarea has a paste interpreter wired up to a
    // ClipboardEvent handler, but plain typing/fill bypasses that and
    // just sets the value normally.
    await addTaskPage
      .getByRole('textbox', { name: 'URLs' })
      .fill(httpFixture.fileUrl)

    // FooterActions renders the submit as <Button> with text "Download"
    // (common.download). After submit the AddTaskWindow auto-closes
    // via electronServices.closeHost; we don't assert on that since
    // hide-vs-close is a window-manager detail.
    await addTaskPage.getByRole('button', { name: 'Download' }).click()

    // Switch the main window to the Downloads route. NavLink renders
    // an <a>; getByRole('link') is the stable accessor across i18n.
    await mainWindow.getByRole('link', { name: 'Downloads' }).click()
    await expect.poll(() => mainWindow.url()).toContain('#/downloads')

    // The row should show the URL-derived name once aria2's first
    // poll lands. Scoping by name ensures we don't pass on an "error"
    // row that aria2 emitted from a previous failure (a real risk
    // we hit during development — see git log around the
    // createTaskHandler `.motrix` mkdir guard).
    const row = mainWindow.getByRole('option').filter({ hasText: 'test.bin' })
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Sanity-check via IPC that the task isn't in `error` — the row
    // appearing is necessary but not sufficient. Lifecycle spec covers
    // the full Downloading → Completed transition; here we just want
    // the add path to land successfully.
    const status = await mainWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          motrix?: { invoke: (channel: string) => Promise<unknown> }
        }
      ).motrix
      const tasks = (await api?.invoke('query:listTasks')) as
        | Array<{ status: string }>
        | undefined
      return tasks?.[0]?.status
    })
    expect(status).not.toBe('error')
  })
})
