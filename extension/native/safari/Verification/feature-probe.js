// Opt-in local acceptance instrumentation; never included in ordinary builds.
const featureAPI = globalThis.browser
const featureKey = 'motrix.safari.featureProbe.v1'
if (location.pathname.endsWith('_generated_background_page.html')) {
  featureAPI.contextMenus.onClicked.addListener((_info, tab) => {
    void featureAPI.storage.session.set({
      [featureKey]: { clickedAt: Date.now(), windowId: tab?.windowId ?? null },
    })
  })
}
if (
  location.pathname.endsWith('/options.html') &&
  location.hash === '#feature-probe'
) {
  const panel = document.createElement('main')
  panel.style.cssText =
    'padding:32px;font:16px system-ui;background:white;color:black;position:fixed;inset:0;z-index:999999;overflow:auto'
  const output = document.createElement('pre')
  output.style.whiteSpace = 'pre-wrap'
  const read = async () => {
    const [windows, session, native] = await Promise.all([
      featureAPI.windows.getAll(),
      featureAPI.storage.session.get([
        featureKey,
        'motrix.downloadConfirmation.v1',
      ]),
      featureAPI.runtime
        .sendNativeMessage('app.motrix.bridge', {
          action: 'notifications.status',
          protocolVersion: 1,
          notificationVersion: 1,
          requestId: crypto.randomUUID(),
        })
        .catch(() => ({ error: 'unavailable' })),
    ])
    output.textContent = JSON.stringify(
      {
        version: featureAPI.runtime.getManifest().version,
        native,
        windows: windows.map(({ id, focused, type }) => ({
          id,
          focused,
          type,
        })),
        click: session[featureKey] ?? null,
        drafts: (session['motrix.downloadConfirmation.v1'] ?? []).map(
          ({ draft }) => ({
            windowId: draft.windowId,
            phase: draft.phase,
            expiresAt: draft.expiresAt,
          })
        ),
      },
      null,
      2
    )
  }
  const refresh = document.createElement('button')
  refresh.textContent = 'Read feature diagnostics'
  refresh.onclick = () =>
    void read().catch(() => {
      output.textContent = 'diagnostic-failed'
    })
  const popup = document.createElement('button')
  popup.textContent = 'Open popup'
  popup.onclick = () => {
    void featureAPI.action
      .openPopup()
      .then(() => {
        output.textContent = 'openPopup accepted'
      })
      .catch((error) => {
        output.textContent = String(error)
      })
  }
  const notificationTest = document.createElement('button')
  notificationTest.textContent = 'Send fixed notification test'
  notificationTest.onclick = async () => {
    notificationTest.disabled = true
    const requestId = crypto.randomUUID()
    try {
      const response = await featureAPI.runtime.sendNativeMessage(
        'app.motrix.bridge',
        {
          action: 'notifications.test',
          protocolVersion: 1,
          notificationVersion: 1,
          requestId,
        }
      )
      output.textContent = JSON.stringify(response, null, 2)
    } catch {
      output.textContent = 'notification-test-result-unknown'
    } finally {
      notificationTest.disabled = false
    }
  }
  panel.append(refresh, popup, notificationTest, output)
  document.body.append(panel)
  void read().catch(() => {
    output.textContent = 'diagnostic-failed'
  })
}
