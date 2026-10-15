import { extensionBrowser as browser } from '@/shared/browser'

export type PairingAction = 'pair-app' | 'add-server'

export function pairingActionFromHash(): PairingAction | null {
  const action = window.location.hash.split('/')[1]
  return action === 'pair-app' || action === 'add-server' ? action : null
}

export async function openBackendPairing(action: PairingAction): Promise<void> {
  const hash = `#integration/${action}`
  if (
    window.location.pathname.endsWith('/options.html') ||
    window.location.pathname.endsWith('/options-preview.html')
  ) {
    window.location.hash = hash
  } else {
    await browser.tabs.create({
      url: browser.runtime.getURL(`options.html${hash}`),
    })
  }
}
