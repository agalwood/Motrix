/** A development-only startup probe avoids relying on Web Inspector evaluation. */
export function safariVerificationProbe(portText) {
  if (!/^[1-9][0-9]{0,4}$/.test(portText ?? '') || Number(portText) > 65535) {
    throw new Error(
      'MOTRIX_SAFARI_VERIFY_PORT must be a loopback port from 1 to 65535'
    )
  }
  return `void (async () => {
const panel = typeof document === 'undefined' ? null : document.getElementById('verification-status');
const root = browser.runtime.getURL('');
const report = text => {
  if (panel) panel.textContent += '\\n' + text;
  browser.action.setTitle({ title: root + ' | ' + text }).catch(() => {});
};
report('Started: ' + new Date().toISOString());
browser.permissions.contains({origins:['http://127.0.0.1/*']}).then(allowed => report('Loopback permission: ' + allowed), () => report('Permission check failed'));
let nativeTimer;
let bootstrap;
try {
  report('Native bootstrap: requesting');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const bindingPub = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await Promise.race([
    browser.runtime.sendNativeMessage('app.motrix.bridge', { action: 'bootstrap', protocolVersion: 1, bindingPub, allowLaunch: false }),
    new Promise((_, reject) => { nativeTimer = setTimeout(() => reject(new Error('timeout')), 20000); })
  ]);
  const errors = ['bootstrap-unavailable', 'invalid-request', 'bootstrap-timeout', 'bootstrap-cancelled', 'invalid-response', 'launch-denied'];
  bootstrap = response?.action === 'requestPair' && response.protocolVersion === 1
    ? { status: 'ok', hasTicket: !!response.nmTicket }
    : { status: 'error', code: errors.includes(response?.error) ? response.error : 'invalid-response' };
} catch { bootstrap = { status: 'error', code: 'native-unavailable' }; }
finally { clearTimeout(nativeTimer); }
report('Native bootstrap: ' + JSON.stringify(bootstrap));
await browser.storage.local.set({ safariBootstrapProbe: { ...bootstrap, checkedAt: new Date().toISOString() } });
report('Stored diagnostic result');
report('Root: ' + browser.runtime.getURL(''));
const socket = new WebSocket('ws://127.0.0.1:${Number(portText)}/safari-verification');
report('WebSocket: connecting');
const timer = setTimeout(() => socket.close(), 5000);
socket.addEventListener('open', () => {
  report('WebSocket: open');
  socket.send(JSON.stringify({event: 'safari-context', root: browser.runtime.getURL(''), bootstrap}));
  clearTimeout(timer);
  socket.close();
});
socket.addEventListener('error', () => { clearTimeout(timer); report('WebSocket: error'); });
socket.addEventListener('close', event => report('WebSocket: closed ' + event.code));
})();
`
}
