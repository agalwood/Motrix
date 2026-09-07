# Web directory picker browser verification

This suite mounts the production `AddTaskDialogHost`, add-task form, directory
picker and Base UI dialogs. Vite replaces only
the renderer transport with a deterministic in-memory filesystem RPC fixture;
settings hydration/persistence and event subscriptions are also fixture-backed.
The General settings dialog and torrent panel are production components too. The
fixture reports the real Web transport platform by default; the explicit Mac key
case uses a Linux platform override to check client OS independence. No server,
aria2, Electron process, native ABI rebuild, or real filesystem mutation is used.
This is browser interaction evidence, not authorization or filesystem evidence;
run the companion real temporary-filesystem service/policy and authenticated RPC
tests as well.

From the repository root:

```bash
pnpm exec playwright test --config e2e/web-directory-picker/playwright.config.ts
```

The config starts and stops its own Vite server at `http://127.0.0.1:4178` and
writes screenshots/traces under `e2e/test-results/web-directory-picker/`. The
`.browser.ts` suffix excludes this suite from the repository’s Electron suite.
If Chromium is not installed, use `pnpm exec playwright install chromium`.
`MOTRIX_BROWSER_EXECUTABLE` optionally selects an already installed compatible
Chromium executable; this does not change package versions.

For manual inspection:

```bash
pnpm exec vite --config e2e/web-directory-picker/vite.config.ts
```

Open `http://127.0.0.1:4178` (or append `?theme=dark`), then Open download dialog
and Change directory. Stop Vite with Ctrl + C. Fixture state resets on reload;
`/archive` contains 800 folders for virtualization checks. Tests cover keyboard
creation/confirmation, Mac client keys with a Linux transport override, pointer navigation,
allowed-root boundaries, exact-path rejection, nested Escape/focus,
parent dialog keyboard isolation during held creation, creation failure and editor
focus restoration, offscreen active descendants and Refresh/Back scroll preservation,
all three entry points and settings Cancel/Save boundaries, and narrow/short
light/dark layouts, native-style sidebar/footer geometry, breakpoint focus and
DOM preservation, and rapid typeahead across navigation. Screenshot capture waits for opaque, settled dialogs; the
harness explicitly scans renderer source for production Tailwind utilities. Generated artifacts are ignored by Git and can be
removed from `e2e/test-results/web-directory-picker/` after inspection.

The keyboard helper waits for frame-scheduled focus transitions after each Tab.
Base UI focus guards use requestAnimationFrame; sending another key before that
transition completes can target a transiently focused control. This is frame
settlement, not a fixed delay or a replacement for native keyboard events. Opening
failures persist the last 100 DOM focus/key/click events and RPC calls as JSON.
