/**
 * Sites that are worth handing to yt-dlp without asking the user.
 *
 * Invoking yt-dlp on every pasted URL would add seconds of latency to every
 * plain file download, so the resolver only runs for hosts that are almost
 * certainly a media page. Anything else stays on the unchanged direct path;
 * a user who wants the resolver for every URL can raise the policy through
 * the `ytdlpAllUrls` setting.
 *
 * Entries are registrable-domain style suffixes: a host matches when it equals
 * the suffix or ends with `.` + suffix, so `music.youtube.com` matches
 * `youtube.com` while `notyoutube.com` does not.
 */
export const DEFAULT_MEDIA_SITE_SUFFIXES: readonly string[] = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  't.co',
  'reddit.com',
  'redd.it',
  'twitch.tv',
  'soundcloud.com',
  'on.soundcloud.com',
  'bilibili.com',
  'b23.tv',
  'nicovideo.jp',
  'vk.com',
  'vkvideo.ru',
  'ok.ru',
  'rutube.ru',
  'pinterest.com',
  'pin.it',
  'streamable.com',
  'bandcamp.com',
  'mixcloud.com',
  'ted.com',
  'archive.org',
  'imgur.com',
  '9gag.com',
  'likee.video',
  'snapchat.com',
  'linkedin.com',
  'loom.com',
  'wistia.com',
  'viddler.com',
  'rumble.com',
  'odysee.com',
  'bitchute.com',
  'peertube.fr',
  'media.ccc.de',
]

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

function matchesSuffix(hostname: string, suffix: string): boolean {
  const needle = normalizeHost(suffix)
  if (!needle) return false
  return hostname === needle || hostname.endsWith(`.${needle}`)
}

/**
 * True when the URL points at a host the resolver should try.
 *
 * Non-HTTP schemes (magnet, ftp, file) are never media pages and are rejected
 * before any lookup, so callers may pass an untrusted URL straight through.
 */
export function isLikelyMediaSite(
  url: string,
  extraSuffixes: readonly string[] = []
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  const hostname = normalizeHost(parsed.hostname)
  if (!hostname) return false
  for (const suffix of DEFAULT_MEDIA_SITE_SUFFIXES) {
    if (matchesSuffix(hostname, suffix)) return true
  }
  for (const suffix of extraSuffixes) {
    if (matchesSuffix(hostname, suffix)) return true
  }
  return false
}
