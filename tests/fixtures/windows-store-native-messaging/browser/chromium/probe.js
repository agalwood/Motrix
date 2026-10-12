// Diagnostic only: no endpoint, pairing, bootstrap, downloads, or network access.
const runtime = globalThis.browser?.runtime ?? globalThis.chrome.runtime
const result = document.getElementById('result')
const button = document.getElementById('probe')
const fields = [
  'schemaVersion',
  'probe',
  'packageIdentityPresent',
  'packageFullNameSha256',
  'expectedPackageName',
  'packageVersion',
  'applicationIdentityPresent',
  'applicationUserModelIdSha256',
  'expectedHelperApplication',
  'chromiumCallerShape',
  'firefoxTestCallerShape',
].sort()

// Classify only known public error shapes. Never copy the message (which can
// contain manifest, executable or profile paths) into the browser result.
// Firefox Subprocess.call checks isExecutableFile before attempting to launch:
// https://github.com/mozilla-firefox/firefox/blob/main/toolkit/modules/subprocess/Subprocess.sys.mjs
const classifyError = (error) => {
  if (!error) return 'none'
  const message = error.message
  if (typeof message !== 'string' || message.length > 8192) return 'other'
  if (message === 'No such native application app.motrix.bridge.store.p0')
    return 'native-host-not-found'
  if (
    /^File at path "[^\r\n]*" does not exist, or is not (?:executable|a normal file)$/.test(
      message
    )
  )
    return 'native-host-not-executable'
  return 'other'
}

button.addEventListener('click', () => {
  button.disabled = true
  result.textContent = 'null'
  let done = false
  let port
  let reply = null
  let messageCount = 0
  let errorPresent = false
  let errorKind = 'none'
  const finish = (status) => {
    if (done) return
    done = true
    clearTimeout(timer)
    result.textContent = JSON.stringify({
      schemaVersion: 1,
      status,
      messageCount,
      errorPresent,
      errorKind,
      reply,
    })
    port?.disconnect()
    button.disabled = false
  }
  const timer = setTimeout(() => finish('timeout'), 12000)
  try {
    port = runtime.connectNative('app.motrix.bridge.store.p0')
    port.onMessage.addListener((value) => {
      if (done) return
      messageCount += 1
      if (messageCount !== 1) return finish('multiple-messages')
      const firefox = runtime.id === 'motrix-store-p0@motrix.invalid'
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields) ||
        value.schemaVersion !== 1 ||
        value.probe !== 'motrix-store-p0' ||
        ![
          'packageIdentityPresent',
          'expectedPackageName',
          'applicationIdentityPresent',
          'expectedHelperApplication',
        ].every((key) => value[key] === true) ||
        typeof value.packageVersion !== 'string' ||
        !/^\d+\.\d+\.\d+\.\d+$/.test(value.packageVersion) ||
        !['packageFullNameSha256', 'applicationUserModelIdSha256'].every(
          (key) =>
            typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key])
        ) ||
        value.chromiumCallerShape !== !firefox ||
        value.firefoxTestCallerShape !== firefox
      ) {
        return finish('invalid-reply')
      }
      reply = value
      // Wait for the native host to disconnect; never claim its exit code or
      // raw framing, which the browser does not expose to this extension.
    })
    port.onDisconnect.addListener(() => {
      const error = runtime.lastError || port.error
      errorPresent = Boolean(error)
      errorKind = classifyError(error)
      finish(reply && messageCount === 1 ? 'reply' : 'disconnected')
    })
    port.postMessage({ probe: 'motrix-store-p0' })
  } catch (error) {
    errorPresent = Boolean(error)
    errorKind = classifyError(error)
    finish('connect-failed')
  }
})
