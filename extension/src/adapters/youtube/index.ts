import type { SiteAdapter } from '@/adapters/SiteAdapter'
import { probeYouTubeUrl } from '@/adapters/youtube/probe'
import { resolveYouTube } from '@/adapters/youtube/resolve'

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',
  version: '0.1.0',
  urlPatterns: ['*://*.youtube.com/*', '*://youtu.be/*'],
  capabilities: ['resolve', 'sniff'],
  matchesUrl: probeYouTubeUrl,
  probe(url): { handled: boolean; confidence?: 'high' | 'medium' | 'low' } {
    return probeYouTubeUrl(url)
      ? { handled: true, confidence: 'high' }
      : { handled: false }
  },
  resolve: resolveYouTube,
}
