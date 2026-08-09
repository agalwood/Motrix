import {
  app,
  commands,
  crypto,
  ffmpeg,
  hooks,
  lifecycle,
  log,
  notify,
  storage,
} from 'motrix:plugin-api'

hooks.beforeCreate(async (ctx) => ctx)

commands.register('test.allcaps.echoAll', async () => {
  // crypto.hash: returns Array<number> in VM (Uint8Array marshaled as array)
  const digestArr = await crypto.hash('sha256', 'abc')
  const digest = Array.from(digestArr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // storage.set: returns {version: number}
  await storage.set('hits', 1)
  const r2 = await storage.set('hits', 2)
  const storageVersion = r2.version

  // crypto.randomBytes: returns Array<number> in VM (not Uint8Array); use .length
  const rb = await crypto.randomBytes(16)
  const randomBytesLen = rb.length

  // app snapshot properties are injected directly (no bridge call)
  const appRuntime = app.runtime

  // notify: only 'show' method is available (no .available property on proxy)
  // Attempt a show; it may throw in server runtime — catch and note unavailable
  let notifyResult = false
  try {
    await notify.show({ title: 'test', body: 'allcaps' })
    notifyResult = true
  } catch (_e) {
    notifyResult = false
  }

  // ffmpeg: only launch methods + probe are available (no .available property on proxy)
  // Attempt probe with a dummy path; it will fail — catch and note unavailable
  let ffmpegResult = false
  try {
    await ffmpeg.probe({ path: '/nonexistent' })
    ffmpegResult = true
  } catch (_e) {
    ffmpegResult = false
  }

  log.info('echoAll complete', { digest })

  return {
    crypto: digest,
    storageVersion,
    randomBytesLen,
    appRuntime,
    notifyResult,
    ffmpegResult,
  }
})

lifecycle.onDeactivate(async () => log.info('bye'))
