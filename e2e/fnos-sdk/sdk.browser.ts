import { expect, type Page, test } from '@playwright/test'

async function mockBackend(page: Page) {
  const selected: string[] = []
  await page.route('**/api/fnos/directory', async (route) => {
    selected.push(route.request().postDataJSON().path)
    await route.fulfill({ json: { path: '/volume/authorized' } })
  })
  await page.route('**/api/fnos/task-path', (route) =>
    route.fulfill({ json: { path: '/volume/authorized/file' } })
  )
  return selected
}

async function extensionHost(page: Page) {
  await page.addInitScript(() => {
    const requests: string[] = []
    Object.assign(window, { extensionRequests: requests })
    window.addEventListener('message', (event) => {
      const message = event.data
      if (
        event.source !== window ||
        message?.source !== 'trimjs-extension-host' ||
        message.kind !== 'request'
      )
        return
      requests.push(message.payload.method)
      const result =
        message.payload.method === 'handshake'
          ? { available: true }
          : message.payload.method === 'getPlatformConfig'
            ? {
                theme: 'light',
                language: 'en-US',
                systemVersion: '1.2.0401',
                format: {},
              }
            : {}
      window.postMessage(
        {
          source: message.source,
          version: 1,
          kind: 'response',
          requestId: message.requestId,
          payload: { ok: true, result },
        },
        location.origin
      )
    })
  })
}

async function authorize(page: Page) {
  await page.context().route('**/app-auth/pick-shared-file?**', (route) => {
    const url = new URL(route.request().url())
    const redirectUri = url.searchParams.get('redirectUri')
    const state = url.searchParams.get('state')
    if (!redirectUri || !state)
      throw new Error('Missing authorization request fields')
    const callback = new URL(redirectUri, url.origin)
    expect(callback.origin).toBe(new URL(page.url()).origin)
    expect(callback.pathname).toBe(new URL(page.url()).pathname)
    callback.search = new URLSearchParams({
      method: 'pickSharedFile',
      appName: 'motrix',
      state,
      status: 'success',
      path: JSON.stringify(['/volume/granted']),
    }).toString()
    return route.fulfill({ status: 302, headers: { location: callback.href } })
  })
}

async function emit(page: Page, event: string, data: string) {
  await page.evaluate(
    ({ event, data }) =>
      window.postMessage(
        {
          source: 'trimjs-extension-host',
          version: 1,
          kind: 'event',
          requestId: 'event',
          payload: { event, data },
        },
        location.origin
      ),
    { event, data }
  )
}

test('reserves the authorization popup before real standalone SDK discovery completes', async ({
  page,
}) => {
  const selected = await mockBackend(page)
  await authorize(page)
  await page.addInitScript(() => {
    const open = window.open.bind(window)
    window.open = (...args: Parameters<typeof window.open>) =>
      navigator.userActivation.isActive ? open(...args) : null
  })
  await page.goto('/app/motrix/')
  const opened = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Choose directory' }).click()
  const popup = await opened
  await expect(page.getByTestId('result')).toHaveText('"/volume/authorized"', {
    timeout: 15_000,
  })
  await expect.poll(() => popup.isClosed()).toBe(true)
  expect(selected).toEqual(['/volume/granted'])
})

test('extension host uses App Auth, rejects unsupported file actions and follows host events', async ({
  page,
}) => {
  await extensionHost(page)
  const selected = await mockBackend(page)
  await authorize(page)
  await page.goto('/app/motrix/')
  await expect(page.locator('html')).toHaveClass(/light/)
  await emit(page, 'os/theme', 'dark')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await emit(page, 'os/language', 'zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  // Focus reconciliation must not restore the SDK's stale initial snapshot.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Choose directory' }).click()
  await expect(page.getByTestId('result')).toHaveText('"/volume/authorized"')
  expect(selected).toEqual(['/volume/granted'])
  await page.getByRole('button', { name: 'Open file', exact: true }).click()
  await expect(page.getByTestId('result')).toContainText('飞牛桌面')
  await page.getByRole('button', { name: 'Reveal folder' }).click()
  await expect(page.getByTestId('result')).toContainText('飞牛桌面')
})

test('explicit Motrix theme and language win over extension host events', async ({
  page,
}) => {
  await extensionHost(page)
  await page.goto('/?explicit')
  await expect(page.locator('html')).toHaveClass(/light/)
  await emit(page, 'os/theme', 'dark')
  await emit(page, 'os/language', 'zh-CN')
  await page.getByRole('button', { name: 'Read config' }).click()
  await expect(page.getByTestId('result')).toContainText('"theme":"dark"')
  await expect(page.locator('html')).toHaveClass(/light/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
})

test('native iframe retains direct directory and file actions with backend authorization', async ({
  page,
}) => {
  const selected = await mockBackend(page)
  await page.goto('/native.html')
  const frame = page.frameLocator('iframe')
  await frame.getByRole('button', { name: 'Choose directory' }).click()
  await expect(frame.getByTestId('result')).toHaveText('"/volume/authorized"')
  expect(selected).toEqual(['/volume/native'])
  await frame.getByRole('button', { name: 'Open file', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { hostCalls: string[] }).hostCalls
      )
    )
    .toContain('openFile')
  await frame.getByRole('button', { name: 'Reveal folder' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { hostCalls: string[] }).hostCalls
      )
    )
    .toContain('openFileManager')
  expect(page.context().pages()).toHaveLength(1)
})

test('native host refresh reads new configuration after an earlier theme event', async ({
  page,
}) => {
  await page.goto('/native.html')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('html')).toHaveClass(/light/)
  await page.evaluate(() => {
    const host = window as unknown as {
      hostConfig: { theme: string }
      hostEmit: (event: string, value: unknown) => void
    }
    host.hostConfig.theme = 'dark'
    host.hostEmit('os/theme', { theme: 'dark' })
  })
  await expect(frame.locator('html')).toHaveClass(/dark/)
  await page.evaluate(() => {
    const host = window as unknown as { hostConfig: { theme: string } }
    host.hostConfig.theme = 'light'
  })
  await frame
    .locator('body')
    .evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(frame.locator('html')).toHaveClass(/light/)
})

test('mobile SDK keeps native file capabilities and refreshes without Web event subscriptions', async ({
  page,
}) => {
  const selected = await mockBackend(page)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'FNOS/1.2.0401 FNAppType/Android FNAppVer/1.34.0',
    })
    const calls: string[] = []
    Object.assign(window, {
      mobileCalls: calls,
      flutter_inappwebview: {
        _platformReady: true,
        async callHandler(method: string) {
          calls.push(method)
          const result =
            method === 'getAppMessage'
              ? { appApi: 'v1.0' }
              : method === 'getPlatformConfig'
                ? {
                    theme: 'dark',
                    language: 'zh-CN',
                    systemVersion: '1.2.0401',
                    format: {},
                  }
                : method === 'pickSharedFile'
                  ? { code: 0, msg: '', data: ['/volume/mobile'] }
                  : {}
          return JSON.stringify({ result: JSON.stringify(result) })
        },
      },
    })
  })
  await page.goto('/')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.getByRole('button', { name: 'Choose directory' }).click()
  await expect(page.getByTestId('result')).toHaveText('"/volume/authorized"')
  expect(selected).toEqual(['/volume/mobile'])
  await page.getByRole('button', { name: 'Reveal folder' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { mobileCalls: string[] }).mobileCalls
      )
    )
    .toContain('openFileManager')
  expect(page.context().pages()).toHaveLength(1)
})
