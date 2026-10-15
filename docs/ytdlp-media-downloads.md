# yt-dlp media downloads

Motrix can use [yt-dlp](https://github.com/yt-dlp/yt-dlp) to turn a link from a
video site (YouTube, Vimeo, bilibili and hundreds more) into real stream URLs,
which Motrix then downloads with its own engine. When FFmpeg is configured,
separate video and audio streams are muxed into a single file automatically.

## Requirements

- A Motrix build that includes this feature.
- The yt-dlp binary, either on your `PATH` or at a path you set in Settings.
- FFmpeg is optional but recommended: without it, Motrix falls back to the best
  single progressive stream instead of muxing the top video and audio streams.

## Enable and configure

Open **Settings → Integration → yt-dlp media extractor**:

- **Extract media links with yt-dlp** — the master switch. When a pasted link
  points at a video site, Motrix asks yt-dlp for the stream URLs before
  downloading. Other downloads are untouched.
- **yt-dlp path** — leave empty to use yt-dlp from your `PATH`. On macOS you may
  need the full path to Homebrew's binary, for example
  `/opt/homebrew/bin/yt-dlp`.
- **Format selector** — passed to yt-dlp as `-f`. Leave empty for the best
  video plus the best audio.
- **Try every link** — also runs the extractor on links that do not look like a
  video page. Slower for ordinary downloads, so it is off by default. Turn it
  on if a site's media links are not recognized.
- **Re-detect yt-dlp** — re-runs detection and shows the detected version, for
  example `yt-dlp 2026.08.19`.

If the detection line stays empty, install yt-dlp from its
[releases page](https://github.com/yt-dlp/yt-dlp/releases) or with your package
manager, set the path, then click **Re-detect**.

## What happens when you download

1. You paste or drop a link into Motrix (or send one from the browser
   extension).
2. If the link's host is a known media site, or **Try every link** is on,
   Motrix runs yt-dlp to resolve the page into direct stream URLs.
3. With FFmpeg configured, the best video and audio streams are downloaded in
   parallel and muxed into one MP4/MKV task, shown as a merge task while it
   runs. Without FFmpeg, Motrix downloads the best single stream directly.

Downloads that are not media links skip the extractor entirely, so ordinary
downloads behave exactly as before.

## Grabbing videos from a web page (browser extension)

The companion browser extension maintained in [motrixapp/motrix-extension](https://github.com/motrixapp/motrix-extension)
(see PR [motrixapp/motrix-extension#56](https://github.com/motrixapp/motrix-extension/pull/56))
includes a media sniffer and an in-page grab overlay:

1. Clone or install the extension from [motrixapp/motrix-extension](https://github.com/motrixapp/motrix-extension).
2. Load the built extension in Chrome, Edge, or Firefox, then pair it with the
   desktop app from the extension popup.
3. Play a video on any page. When the sniffer detects it, click the grab
   button the extension overlays on the page (or open the popup for the full
   list).
4. Choose an item to send it to Motrix. Direct streams download immediately;
   HLS/DASH pages and watch-page URLs are resolved server-side, using yt-dlp
   when enabled, exactly like a pasted link.
5. When yt-dlp is enabled, the overlay additionally lists the page's own
   qualities: a **Video** section with one row per resolution (e.g. `1080p`,
   `720p`) and an **Audio** section with an **MP3** row when FFmpeg is
   configured. Picking a resolution downloads the best stream at or below it;
   picking **MP3** downloads the best audio stream and converts it to a
   `.mp3` file. The list is fetched from the desktop app automatically when a
   video starts playing (refreshed at most once a minute), so ordinary sniffed
   items keep their own rows alongside it.

The overlay only runs in the top frame of `http(s)` pages and shows a thin
label (filename or resolution) — page code never sees the stored stream URL or
cookies.

## Troubleshooting

- **The link downloads as a tiny HTML file** — the site is not in the built-in
  media-site list. Turn on **Try every link**, or use the browser extension's
  grab overlay on the playing video.
- **The task is a single stream instead of a merge** — FFmpeg was not detected.
  Configure **Settings → Integration → Media Tools**, then re-download.
- **yt-dlp version errors** — update yt-dlp regularly; video sites change
  frequently and old extractor versions break.
- **The overlay shows no quality rows** — the desktop app could not list the
  page (yt-dlp disabled, missing, or the site is not allowed). The overlay then
  falls back to the sniffed items and the this-page row; check the yt-dlp
  settings and that the app is connected.
