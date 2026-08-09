chrome.runtime.onStartup.addListener(async () => {
  const port = chrome.runtime.connectNative('app.motrix.bridge')
  port.onMessage.addListener((msg) => {
    // First message is { action: 'requestPair', port, nonce } from NM host
    if (msg.action === 'requestPair') {
      // Connect to /pair WS to trigger Motrix's dialog.
      // For E2E, the test will assert that the dialog opens.
    }
  })
})
