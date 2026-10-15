import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest((env) => {
  const firefox = env.mode === 'firefox'
  const safari = env.mode === 'safari'
  const webStore =
    env.mode === 'webstore' || process.env.MOTRIX_BUILD === 'webstore'
  const includeYouTube = !webStore && !firefox && !safari
  const genericSnifferScripts = [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/sniffer-relay.ts'],
      run_at: 'document_start' as const,
      all_frames: true,
      world: 'ISOLATED' as const,
    },
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/sniffer-entry.ts'],
      run_at: 'document_start' as const,
      all_frames: true,
      world: 'MAIN' as const,
    },
    // In-page grab overlay (top frame only — one pill per page). It reads the
    // sniffer's findings through the background and never touches page media
    // itself, so it can start once the DOM exists.
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/grab-overlay.ts'],
      run_at: 'document_idle' as const,
      all_frames: false,
      world: 'ISOLATED' as const,
    },
  ]
  return {
    manifest_version: 3,
    // Name and description resolve from public/_locales/<code>/messages.json.
    // Each locale listed there is also a language the Chrome Web Store lets
    // us localize the listing (description, screenshots) for.
    default_locale: 'en',
    name: '__MSG_appName__',
    version: pkg.version,
    description: '__MSG_appDescription__',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      96: 'icons/icon-96.png',
      128: 'icons/icon-128.png',
    },
    permissions: [
      // Temporary Safari extensions have no containing native app.
      ...(!safari ? ['nativeMessaging'] : []),
      'storage',
      'activeTab',
      'scripting',
      'alarms',
      ...(!safari ? ['notifications'] : []),
      'contextMenus',
      ...(!safari ? ['downloads'] : []),
      'cookies',
      'webRequest',
      // Firefox-only: blocking webRequest lets the PoC cancel a download
      // response before the download manager starts it (IDM-style early
      // takeover). Chrome MV3 forbids this permission, hence the gate.
      ...(firefox ? ['webRequestBlocking'] : []),
      'webNavigation',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_popup: 'popup.html',
      default_title: 'Motrix',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [
      ...genericSnifferScripts,
      ...(includeYouTube
        ? [
            {
              matches: ['*://*.youtube.com/*', '*://youtu.be/*'],
              js: ['src/content/index.ts'],
              run_at: 'document_idle' as const,
            },
          ]
        : []),
    ],
    // Generic discovery is backend-independent and starts in every frame.
    // Both browsers use a MAIN-world collector plus an ISOLATED runtime relay
    // so page fetch/XHR are observable. Firefox requires 128+ for MAIN-world
    // manifest content scripts; the relay keeps an isolated fallback if the
    // MAIN-world hello never arrives. Dynamic injection remains available for
    // explicit SPA rescans.
    //
    // IMPORTANT: the SW entry is `service-worker.ts`, NOT `index.ts`. The content script is
    // `src/content/index.ts`; if the SW entry were also named `index.ts`, both emit
    // `index.ts-<hash>.js` and crxjs's service-worker-loader resolves to the WRONG chunk
    // (the content bundle), so the SW never registers its onMessage listener and every
    // popup request fails with "Could not establish connection. Receiving end does not exist."
    // Keep this basename unique. (See debugging notes 2026-06-29.)
    // Safari 27's service-worker WebSocket constructor can deadlock its
    // WebContent main thread. Reuse the same entry in a nonpersistent page.
    background:
      firefox || safari
        ? {
            scripts: ['src/background/service-worker.ts'],
            type: 'module',
            ...(safari ? { persistent: false } : {}),
          }
        : {
            service_worker: 'src/background/service-worker.ts',
            type: 'module',
          },
    ...(firefox
      ? {
          // Firefox's default Manifest V3 CSP includes
          // `upgrade-insecure-requests`, which rewrites the loopback MBP1
          // transport from ws:// to wss://. Motrix deliberately serves the
          // local bridge over plain WebSocket because MBP1 authenticates and
          // encrypts the session itself, so keep the extension policy strict
          // while explicitly opting out of that scheme rewrite.
          content_security_policy: {
            extension_pages: "script-src 'self'; object-src 'self';",
          },
          browser_specific_settings: {
            gecko: {
              id: 'motrix-extension@motrix.app',
              // Firefox 140 introduced the built-in data-transmission consent
              // experience on desktop, while Firefox for Android gained the
              // same manifest support in 142. Use the shared floor so AMO does
              // not advertise an unsupported Android compatibility range. It
              // also includes the execution-world support used by the generic
              // fetch/XHR collector (introduced in Firefox 128).
              strict_min_version: '142.0',
              data_collection_permissions: {
                required: [
                  'authenticationInfo',
                  'browsingActivity',
                  'websiteContent',
                  'websiteActivity',
                ],
              },
            },
            // Firefox for Android has no Native Messaging, but remote Motrix
            // Server pairing uses the network transport and remains useful.
            // Android 142 is the first release with the built-in data consent
            // manifest support declared above.
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : safari
        ? {}
        : { minimum_chrome_version: '120' }),
  }
})
