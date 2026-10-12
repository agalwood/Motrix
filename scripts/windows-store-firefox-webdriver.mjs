import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readInstalledFile } from './test-windows-store-native-messaging-alias.mjs'
import { killOwnedProcess } from './test-windows-store-native-messaging-browser.mjs'

const fail = () => {
  throw new Error('firefox-webdriver-failed')
}
const EXTENSION_ID = 'motrix-extension@motrix.app'

export function decodeFirefoxWebDriverResponse(ok, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536) fail()
  let payload
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  } catch {
    fail()
  }
  if (
    !ok ||
    !payload ||
    !Object.hasOwn(payload, 'value') ||
    payload.value?.error
  )
    fail()
  return payload.value
}

/** Normal WebDriver input, with the same temporary install and read-only metadata. */
export async function openFirefoxWebDriver({
  inventory,
  profileDirectory,
  driverExecutable,
  observe = () => {},
}) {
  let phase = 'driver-file'
  const progress = (value) => {
    phase = value
    observe({ phase })
  }
  progress(phase)
  if (
    process.platform !== 'win32' ||
    !path.isAbsolute(driverExecutable) ||
    path.win32.basename(driverExecutable).toLowerCase() !== 'geckodriver.exe'
  )
    fail()
  const driver = await readInstalledFile(driverExecutable, 16 * 1024 * 1024)
  // geckodriver is larger than the tiny diagnostic fixture; check the fixed PE
  // header independently without increasing the fixture's existing limit.
  if (driver.length < 256 || driver.toString('ascii', 0, 2) !== 'MZ') fail()
  const offset = driver.readUInt32LE(0x3c)
  if (
    offset < 64 ||
    offset > driver.length - 94 ||
    driver.readUInt32LE(offset) !== 0x4550 ||
    driver.readUInt16LE(offset + 4) !== 0x8664 ||
    driver.readUInt16LE(offset + 24) !== 0x20b ||
    driver.readUInt16LE(offset + 92) !== 3
  )
    fail()
  const digest = createHash('sha256').update(driver).digest('hex')
  progress('driver-port')
  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const child = spawn(
    driverExecutable,
    ['--host', '127.0.0.1', '--port', String(port), '--log', 'fatal'],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  progress('driver-start')
  let outputBytes = 0
  let outputFailure = false
  child.on('error', () => {
    outputFailure = true
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 65536) outputFailure = true
    })
  const closed = new Promise((resolve) => child.once('close', resolve))
  const base = `http://127.0.0.1:${port}`
  let sessionId
  let sessionClosed = false
  async function request(method, route, body) {
    if (outputFailure) fail()
    const response = await fetch(base + route, {
      method,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    })
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 65536) fail()
      chunks.push(Buffer.from(chunk))
    }
    if (!response.ok) observe({ phase, httpStatus: response.status })
    return decodeFirefoxWebDriverResponse(response.ok, Buffer.concat(chunks))
  }
  const route = (suffix) => `/session/${sessionId}${suffix}`
  async function switchWindow(handle) {
    if (typeof handle !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(handle))
      fail()
    await request('POST', route('/window'), { handle })
  }
  async function evaluate(expression, chrome = false) {
    if (typeof expression !== 'string' || expression.length > 16384) fail()
    await request('POST', route('/moz/context'), {
      context: chrome ? 'chrome' : 'content',
    })
    try {
      const result = await request('POST', route('/execute/async'), {
        script:
          'const done=arguments[arguments.length-1]; Promise.resolve().then(()=>eval(arguments[0])).then(value=>done({ok:true,value}),()=>done({ok:false}));',
        args: [expression],
      })
      if (result?.ok !== true) fail()
      return result.value
    } finally {
      if (chrome)
        await request('POST', route('/moz/context'), { context: 'content' })
    }
  }
  async function close() {
    if (sessionClosed) return
    sessionClosed = true
    let failed = false
    if (sessionId)
      try {
        await request('DELETE', route(''))
      } catch {
        failed = true
      }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
        await Promise.race([closed, delay(3000)])
      } catch {
        failed = true
      }
      if (child.exitCode === null && child.signalCode === null)
        await killOwnedProcess(child.pid)
    }
    if (failed)
      throw Object.assign(new Error('browser-cleanup-failed'), {
        code: 'browser-cleanup-failed',
      })
  }
  try {
    progress('driver-ready')
    let ready = false
    for (let i = 0; i < 50; i++) {
      try {
        ready = (await request('GET', '/status'))?.ready === true
      } catch {}
      if (ready) break
      if (child.exitCode !== null || outputFailure) fail()
      await delay(200)
    }
    if (!ready) fail()
    progress('session-new')
    const created = await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            binary: inventory.executable,
            args: [
              '--headless',
              '--profile',
              profileDirectory,
              '--remote-allow-system-access',
            ],
          },
        },
      },
    })
    progress('session-identity')
    sessionId = created?.sessionId
    if (
      typeof sessionId !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
      created.capabilities?.browserName !== 'firefox'
    )
      fail()
    progress('session-ready')
    return {
      version: created.capabilities.browserVersion,
      driverSha256: digest,
      close,
      async command(method, params) {
        if (method === 'webExtension.install') {
          if (params.extensionData?.type !== 'path') fail()
          const extension = await request('POST', route('/moz/addon/install'), {
            path: params.extensionData.path,
            temporary: true,
          })
          return { extension }
        }
        if (method === 'webExtension.moz:listExtensions') {
          const value = await evaluate(
            `(async()=>{const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const a=await AddonManager.getAddonByID('${EXTENSION_ID}');const p=WebExtensionPolicy.getByID('${EXTENSION_ID}');return {extensions:a?[{id:a.id,isActive:a.isActive,isSystem:a.isSystem,hidden:a.hidden,manifestVersion:a.manifestVersion,version:a.version,temporarilyInstalled:a.temporarilyInstalled,sourceURL:a.sourceURI?.spec??null,policy:p?{uuid:p.mozExtensionHostname,baseURL:p.baseURL,extensionURL:p.getURL('')}:null}]:[]}})()`,
            true
          )
          return value
        }
        if (method === 'browsingContext.create')
          return {
            context: (
              await request('POST', route('/window/new'), { type: 'tab' })
            ).handle,
          }
        if (method === 'browsingContext.navigate') {
          await switchWindow(params.context)
          await request('POST', route('/url'), { url: params.url })
          return {}
        }
        if (method === 'script.evaluate') {
          await switchWindow(params.target.context)
          const value = await evaluate(params.expression)
          if (typeof value !== 'string') fail()
          return { type: 'success', result: { type: 'string', value } }
        }
        if (method === 'input.performActions') {
          await switchWindow(params.context)
          await request('POST', route('/actions'), { actions: params.actions })
          return {}
        }
        if (method === 'browsingContext.close') {
          await switchWindow(params.context)
          await request('DELETE', route('/window'))
          return {}
        }
        fail()
      },
    }
  } catch {
    observe({ phase, failed: true })
    await close()
    fail()
  }
}
