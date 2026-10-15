# Motrix Extension

English | [简体中文](./README.zh-CN.md)

The official browser extension for [Motrix](https://motrix.app). Send downloads from your browser to Motrix, then check their progress and manage the tasks from the same small window. The extension can also find video, audio, and images loaded by the current page so you can choose what to save.

I think of it as a bridge between the browser and Motrix. The browser is good at finding resources; Motrix is good at downloading them reliably. That division of labor is simple, and it feels right in daily use.

> [!IMPORTANT]
> Motrix Extension is available from the Chrome Web Store, Microsoft Edge Add-ons, and Firefox Add-ons. Safari is available as the packaged `Motrix Extension for Safari.app`, released alongside Motrix. YouTube downloads are not supported; store-facing Chrome/Edge and Firefox builds remove the placeholder YouTube adapter entirely.

## What you can do

- Right-click a link and choose **Download with Motrix**.
- Paste an HTTP, HTTPS, or magnet link to create a task.
- Let Motrix take over eligible browser downloads, with a size threshold and a list of sites to leave alone.
- Scan resources already loaded by the current page, filter them by video, audio, or image, and submit a selection in one batch.
- Check speeds and task status in the extension. You can pause, resume, or remove tasks and, when supported, ask Motrix to reveal the downloaded file.
- Connect to the Motrix App on this computer or save and switch between several remote Motrix Servers.

This is useful, but websites are messy. Login state, expiring URLs, hotlink protection, DRM, and each site's player design can all change the result. The extension keeps the request details a download may need, but it does not bypass DRM and cannot promise that every resource visible on a page can be downloaded on its own.

## Before you start

You will need:

- Chrome 120 or later, a current Microsoft Edge release, Firefox 142 or later, or Safari on macOS 13 or later;
- a Motrix App or Motrix Server compatible with the current MDXP / MBP1 protocol;
- for initial local pairing, start the Motrix App and make sure its browser integration component is installed correctly.

Firefox for Android connects through Motrix Server. Native Messaging is not
available there, so the local Motrix App backend is shown only on desktop.

## Install

Install [Motrix 2](https://motrix.app/download?channel=beta), then install the extension for your browser:

- [Chrome Web Store](https://chromewebstore.google.com/detail/motrix-extension/lggbokfckofcgjndaboioakcmincinpo)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/motrix-extension/efcflljngohddnmfmebiamigoikmdfbf)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/motrix-extension/)
- [Safari for macOS](https://github.com/motrixapp/motrix-extension/releases?q=safari&expanded=true)

Store installations do not require Developer mode or a manually added trusted extension ID. Follow [Connect for the first time](#connect-for-the-first-time) below to pair with Motrix, or read the [browser extension guide](https://motrix.app/manual/browser-extension/).

For Safari, download and extract the macOS ZIP, move `Motrix Extension for Safari.app` to Applications, then open it and enable **Motrix Extension** in **Safari Settings → Extensions**. Grant website access as needed and pair with Motrix. The signed and notarized app is ready to use with the accompanying Motrix release; no developer mode or unsigned-extension setting is needed. Safari supports App/Server connections, pairing, reconnect, and download submission. Automatic download interception is unavailable in Safari.

Local browser integration is not currently available in the Motrix AppImage package. On Linux, use the DEB or RPM package for local pairing.

## Manual browser workflow (development)

<details>
<summary>Install a test build from source</summary>

You need Node.js 22.13+ (22.x), 24.x, or 26+, and pnpm 12
(the version pinned in `package.json`).

```bash
pnpm install
pnpm build:chromium
pnpm build:firefox
```

Chrome or Edge: open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/chromium/`.

An unpacked Chrome or Edge development build may receive an ID outside Motrix's built-in trust list. If its ID is not already trusted, add it before pairing; otherwise Motrix rejects the connection before it shows a pairing code.

1. Stay on `chrome://extensions` or `edge://extensions`, find Motrix Extension, and copy the ID shown on its card.
2. In Motrix, open **Settings → Integration → Browser extensions** and make sure **Send downloads from browser extensions** is enabled.
3. Expand **Trusted extensions**, choose **Add extension**, paste the ID, select **Chrome / Edge**, and choose **Add**. The label is optional.
4. Return to the extension, connect to Motrix again, and complete pairing when prompted.

Only add the ID you copied from your browser's extension-management page. Chrome or Edge may assign a different ID if you move the unpacked build to another directory or install it on another computer. If that happens, remove the old entry from Motrix and add the new one.

Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Firefox removes temporary extensions when it restarts.

Safari 18.4+ on macOS: run `pnpm build:safari`, then choose **Settings → Developer → Add Temporary Extension** and select `dist/safari/`. Enable web developer features and allow unsigned extensions when Safari prompts. Safari removes temporary extensions when it quits or after 24 hours.

Loading `dist/safari/` directly is only for testing the web UI: it lacks the native messaging component needed to connect to Motrix. Use the [packaged Safari app](#install) for normal use, including App/Server connections.

To develop the native integration, install full Xcode and follow the [Safari build and distribution instructions](./native/safari/README.md). Desktop integration requires a compatible same-Team Motrix bootstrap service. The dedicated GitHub Actions workflow handles Developer ID signing and notarization for Safari releases.

</details>

## Connect for the first time

### Motrix on this computer

1. Start the Motrix App.
2. Select the Motrix icon in the browser toolbar, then choose **Pair**.
3. If the extension finds more than one Motrix instance, select the one you want.
4. Enter the eight-character pairing code shown by Motrix.

After pairing, the extension retains the credential when you quit Motrix. You can send a download while the App is closed: the extension starts it when needed and reconnects with the saved pairing. Opening the extension alone does not start the App. Choose **View tasks** to connect and see progress. Remote Servers must already be running and reachable.

The backend indicator is blue when paired and waiting, green when connected, orange while connecting, gray when unpaired, and red when an error needs attention. Hover over the selector for its status. Unavailable live statistics appear as `—`.

If a send loses its response, check the task list before trying again. The extension keeps the result uncertain instead of automatically creating another download. A connection failure does not erase your pairing; pair again only after explicitly forgetting it or revoking it in Motrix.

### A remote Motrix Server

Open **Settings → Integration**, add a name and a `ws://` or `wss://` address, then complete pairing.

Use `wss://` for remote connections when possible. Task content still has application-level encryption over `ws://`, but plain WebSocket cannot reliably prove the server's identity and may expose connection metadata. Once a connection crosses the internet or a NAS reverse proxy, that difference stops being academic.

Pairing credentials and data permissions are isolated per Server. Pairing proves which Server you reached; it does not give that Server permission to receive browser data. You must enable **Remote downloads** separately. Cookies and page-derived request headers start disabled and must also be granted per Server.

## Three ways to download

### Right-click a link

Right-click a download link on a page and choose **Download with Motrix**. This is the most direct route, and automatic takeover does not need to be enabled.

Right-click handoff also supports a selected remote Server after pairing and enabling **Remote downloads**. Cookies and request headers remain subject to that Server's separate data permissions.

Enable **Settings → Downloads → Ask before downloading** to automatically open the same confirmation form for right-click submissions and eligible intercepted downloads. The switch is also available in popup quick settings. Turning it off sends directly to Motrix. Automatic takeover remains a separate preference, and its size and site-exclusion rules still apply. No source probe is made before confirmation; unknown sizes use the configured unknown-size policy. This works independently of **Open task panel after adding a download**. The form offers a filename override, the current browser User-Agent, Referer, Cookie, Authorization, and additional headers. Leave Save to unchanged to use Motrix's default directory, or choose an available directory on a supported host.

Closing the popup preserves the draft and edits for the remainder of its two-minute lifetime. Reopen the extension in the same browser window to resume. Session storage allows recovery after background-worker suspension, including incomplete form fields. Explicit cancellation, expiry, closing the originating browser window, or switching the selected backend discards the draft. Browser restart and extension reload/update clear session storage. Temporary download links may expire sooner than the draft. Browsers without automatic popup support disable enabling this preference and recommend upgrading; an already enabled preference can still be turned off.

Connection or submission failures keep the form and its edits without automatically falling back to the browser. An unknown submission result, including recovery of an interrupted submission, blocks resubmission. The confirmation popup stays bound to its original window and selected backend.

For right-click submissions, the source request starts only after confirmation. For intercepted downloads, the browser has already requested the resource. The extension releases its short filename hold before opening the form and keeps the original download running, including if the popup closes or Motrix submission fails. **Keep browser download** dismisses the form without another request. Choosing Motrix starts a separate request and may fail for one-use links or create a duplicate; the form explains this before submission. The extension cannot transfer the browser's existing response stream or guarantee interception before every cloud provider's first request.

### Create a task manually

Once Motrix is connected, open the **Tasks** tab and select the plus button in the upper-right corner. Paste one HTTP, HTTPS, or `magnet:?` address. The current version accepts one address at a time. HTTP(S) tasks use the same filename and request-options fields as the confirmation form, with the current browser User-Agent filled in. Retrying an unchanged submission preserves its identity; editing its address or options starts a new submission.

### Choose a download directory

The confirmation and quick-add forms can select the connected Motrix host's
available default, favorite, and recent directories (requires MDXP 0.7.0 support
in Motrix). Manage these directories in Motrix. This picker does not browse the
filesystem or create folders. Older/disconnected hosts keep default-directory
submission available; an existing explicit choice is preserved and rejected if
unsupported or stale until you select a valid directory or explicitly return to
the default. Directory drafts are bound to the backend and paired instance.

### Choose resources from the page

Open the **Sniffer** tab. It lists video, audio, and images loaded by the current page; images can be narrowed further by format, dimensions, and file size. On a page that uses lazy loading, scroll through it or start playback before selecting **Scan again**. The results are usually more complete.

One distinction matters here: finding a resource does not guarantee a successful download. Some URLs expire quickly. Some video needs separate audio and video tracks that Motrix must merge with ffmpeg, while other media is protected by DRM. The extension marks selections the current backend cannot handle instead of pretending that the task was accepted.

## Browser download takeover

When **Takeover** is on, eligible browser downloads are sent automatically to the local Motrix App. A remote Server accepts manual tasks, selected page resources, and right-click submissions when its remote-download permission is enabled. Automatic takeover remains limited to the local App.

The settings let you define:

- a minimum file size, below which the browser keeps the download;
- a denylist with one host per line, which the browser always handles itself.

Takeover is off by default and asks for confirmation the first time it is enabled. There is a concrete reason: to keep authenticated downloads working, the extension may read cookies for the target domain and send them with the task to Motrix. A built-in sensitive-host list excludes some banking, government, and medical sites. If Motrix cannot accept an ordinary HTTP(S) download, the extension tries to return it to the browser. Magnet links have no equivalent browser download to fall back to.

**Open task panel after takeover** is an optional switch under Settings → Downloads, off by default. On Chrome/Edge 127+ and Firefox 149+, it opens the extension popup only after Motrix confirms an automatic download. A run of downloads less than 10 seconds apart opens it once; an existing popup refreshes without changing its tab or filter. Switching windows or closing the panel does not cause that batch to reopen it. Apply saves the preference.

If an RPC request times out, the panel checks the connection, preserving its last task data while controls and polling pause. Recovery probes the existing session, then makes at most one reconnect with stored credentials. Only task/status reads may be retried once. Download submissions and task actions are never automatically replayed; an uncertain submission still needs checking in Motrix before retrying.

## Data and permissions

Your browser will say that this extension can access every website, downloads, and cookies. That is broad access. I do not want to hide it behind a vague “required for operation,” so here is what each part is for.

| Permission | Why it is used |
| --- | --- |
| Pages and network requests | Find links, media manifests, images, and other resources the page has loaded |
| Downloads | Take over a download and restore it to the browser if handoff fails |
| Cookies | Preserve an authenticated download when you submit a page resource or consent to takeover; remote Servers require another explicit grant |
| Native Messaging | Discover and connect to the Motrix App on this computer |
| Local storage | Keep settings, the Server list, pairing credentials, and per-Server permissions |
| Notifications and context menus | Report handoff results and add the **Download with Motrix** action |

Page-resource scanning happens locally in the browser. Opening a page does not send its full contents to Motrix. When you actually submit a task, the selected backend receives what it needs for the download: this can include the target URL, source page URL and title, and a suggested filename. Whether cookies and request headers are included depends on the download path, backend type, and the permissions you granted.

Remote Server permissions start at the narrowest scope. Unless you explicitly enable them, the extension does not send cookies or authentication headers to a remote Server. Grant those permissions only to a Server you control.

## Common questions

### How do I diagnose a failed connection?

Click **Diagnose** in the error panel. The extension enables debug logging and checks installation type, permissions, stored pairing, Native Host access, and bridge discovery ports. For a remote Server it checks the selected discovery endpoint. Results, timings, and developer guidance appear inside the error panel; the small button at the report's top right copies the full report. Background failures and timeouts still leave copyable error and environment information.

`management.getSelf().installType` identifies unpacked development installations without an extra `management` permission; it cannot detect whether DevTools is open. The extension cannot read local allowlists directly, so findings distinguish denied Native Host access, missing host registration, and a stopped App. Diagnostics do not launch Motrix, re-pair, or clear credentials. The existing Native Host probe protocol may issue one unused nonce, which is discarded. Reports exclude pairing keys, nonces, tickets, and complete backend profiles.

After diagnosis, use **Connect** to reproduce the failure and inspect subsequent debug logs in the extension background console. Restore the log level under the extension's **Settings → Help** when finished.

### Why can't the Chrome or Edge development build connect to Motrix?

Check that its extension ID appears under **Settings → Integration → Browser extensions → Trusted extensions** in Motrix. You can copy the ID from the Motrix Extension card on `chrome://extensions` or `edge://extensions`. If you loaded the build from a different directory, the browser may have assigned a new ID, so update the Motrix entry as well.

### Why can't the extension find Motrix on this computer?

Make sure Motrix is running, then scan again. If it is still missing, check whether the browser lets the extension reach local addresses and whether Motrix's browser integration component is installed. An older Motrix build may also be incompatible with the current pairing protocol.

### Why is a video on the page missing from the resource list?

Start playback for a few seconds and scan again. Detection uses page elements and requests that have actually happened, so the extension cannot see media that has not loaded yet. `blob:` URLs, DRM streams, short-lived links, and custom player packaging may also be unusable.

### Why is a paired remote Server refusing downloads?

Pairing answers “which Server is this?” It does not answer “what may I send it?” Open **Settings → Integration** and enable **Remote downloads** for that Server. If the resource also relies on a Referer, cookies, or authentication headers, grant only the additional permissions it needs.

### Can it download from YouTube?

Not yet.

## For developers

```bash
pnpm dev                 # Chromium development build
pnpm dev:firefox         # Firefox development build
pnpm test                # Test suite
pnpm lint                # Code checks
pnpm build:webstore      # Chrome Web Store-compliant build
```

### Localize the store listing

The manifest `name` and `description` come from
`public/_locales/<code>/messages.json` (`__MSG_appName__`, `__MSG_appDescription__`),
with `en` as `default_locale`. Every locale directory there is also a language
the Chrome Web Store listing editor lets you localize, including its own set of
screenshots and description. To add a language, add a `messages.json` with the
same keys; `src/__tests__/manifest-locales.test.ts` checks that all locales
stay complete and in sync. The in-app UI strings are separate
(`src/shared/locales/*.json`, i18next).

The extension ships 27 UI languages and matching store metadata: `ar`, `bg`,
`ca`, `de`, `el`, `en-US`, `es`, `fa`, `fr`, `hi`, `hu`, `id`,
`it`, `ja`, `ko`, `nb`, `nl`, `pl`, `pt-BR`, `ro`, `ru`, `th`,
`tr`, `uk`, `vi`, `zh-CN`, and `zh-TW`. Existing Hindi support is retained.
Store directories use browser locale codes: `en` for `en-US`, `no` for
Norwegian Bokmål (`nb`), and underscores in `pt_BR`, `zh_CN`, and `zh_TW`.

All languages are available under **General → Language**, with automatic
browser-language detection and a saved override. Traditional Chinese is selected
for `zh-TW`, `zh-HK`, `zh-MO`, and `zh-Hant`; Norwegian `no` maps to `nb`.
Arabic and Persian use right-to-left layouts and keyboard navigation. URLs and
pairing codes retain left-to-right input order. Open extension pages update when
the language preference changes.

English and Chinese are the editorial reference translations. Keep their approved
copy intact when retranslating other languages. Translate every key from these
references, preserve interpolation placeholders and technical identifiers, and
use consistent terms for pairing, download takeover, and server permissions.
Count labels can use number-independent wording; sentences that need grammatical
plural forms should use i18next plural variants.

When adding a language, register it in `src/shared/supportedLocales.ts` and
`src/shared/i18n.ts`, and add its store metadata. Locale tests verify every key
and interpolation placeholder. If the i18n-expert skill is installed, use its audit script to check static
translation calls; dynamic keys also need manual review. Run the locale and page-direction tests,
then inspect the popup and options previews with `?lang=ar` or `?lang=fa` for RTL
changes.

### Browser APIs and types

Import the API value and its types explicitly through the shared adapter:

```ts
import { type Browser, extensionBrowser } from '@/shared/browser'

const tabs: Browser.tabs.Tab[] = await extensionBrowser.tabs.query({ active: true })
```

The module-scoped `Browser` namespace comes from the standalone
[`@wxt-dev/browser`](https://wxt.dev/guide/essentials/extension-apis) package;
the project continues to build with CRXJS. Do not add the ambient
`@types/chrome` or `@types/firefox-webext-browser` packages, or access browser
globals in application code. Firefox-only type additions belong in
`src/shared/browser-types.d.ts` and must retain runtime feature checks.

The adapter keeps `webextension-polyfill` for the supported Chrome 120+
baseline. Use Promise-based calls. The polyfill is a no-op on Firefox and
Chrome 148+; removing it requires a deliberate compatibility change, as
explained in [Chrome's migration guide](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace).
Chromium's callback-sensitive `onDeterminingFilename` event uses the adapter's
`nativeBrowser` export with feature detection. Browser globals are never
installed or overwritten by the adapter.

`pnpm run typecheck` includes a separate browser API contract check with
`skipLibCheck: false`, checking vendor declarations and rejecting accidental
ambient globals. Lint rejects direct API-package imports outside the adapter.
The patch for `@wxt-dev/browser@0.3.0` corrects two leftover `typeof chrome`
references in its generated declarations to `typeof Browser`; remove the
patch when an upstream version passes the contract check without it.
CI runs these checks, the regression suite, and all three build variants for
pull requests and `main` pushes.

### Publish a GitHub release

Releases are built by GitHub Actions from an existing `vX.Y.Z` tag. Update the
version in `package.json`, commit the change, then create and push the matching
tag:

```bash
git tag -a v0.1.2 -m "Motrix Extension 0.1.2"
git push origin v0.1.2
```

The workflow runs the checks and tests, builds the Chrome/Edge Web Store and
Firefox variants, verifies their manifest versions, and publishes both ZIP
files, a reproducible source ZIP for Firefox review, and `SHA256SUMS.txt` to a
GitHub Release with signed provenance. Tags must point to commits already on
`main`. For a manual **Release browser extension** run, select the same tag as
both the workflow ref and the `tag` input.

### Submit updates to Chrome, Edge, and Firefox

All three store listings already exist. After creating a GitHub Release, run
**Submit browser extension to stores** from the `main` branch. Select its
`vX.Y.Z` tag and either `all` or one store. The workflow verifies and submits
the existing release ZIPs, including Firefox sources, in independent jobs.
It does not rebuild the release. Dry runs are the default; live uploads require
`dry_run=false`. Both require approval in the corresponding store environment.
Releases without provenance cannot be submitted. Each job reports whether
submission succeeded; store review and public availability happen separately.

Apply [repository protection](.github/security/README.md) before adding store credentials.
See [Store submission](docs/store-submission.md) for the environment-scoped credentials,
GitHub CLI commands, dry-run limitations, and recovery from partial failures.

The main areas of the codebase are:

- `src/background/` — pairing, connections, download handoff, task controls, and stored configuration;
- `src/popup/` — the extension popup;
- `src/options/` — the settings page;
- `src/content/` — page-resource detection;
- `src/adapters/` — site adapters.

## Related projects

- [Motrix](https://github.com/agalwood/Motrix) — desktop app and server
- [motrix-extension](https://github.com/motrixapp/motrix-extension) — public extension repository
- [MDXP](https://github.com/motrixapp/mdxp) — protocol schemas and connection helpers

## License

[MIT](./LICENSE) © 2026-present Dr_rOot
