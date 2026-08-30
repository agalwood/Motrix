/**
 * Central registry for external URLs used across main and renderer —
 * help menu links, docs deep-links, issue tracker. Keep all hardcoded
 * public URLs here so migrations (domain change, docs restructure,
 * locale-specific redirects) only touch one file.
 */
export const EXTERNAL_URLS = {
  github: {
    repository: 'https://github.com/agalwood/Motrix/',
    author: 'https://github.com/agalwood/',
    issues: 'https://github.com/agalwood/Motrix/issues/',
    ffmpegStaticReleases:
      'https://github.com/motrixapp/ffmpeg-static/releases/latest',
  },
  motrix: {
    home: 'https://motrix.app/',
    acknowledgments: 'https://motrix.app/acknowledgments',
    plugins: 'https://motrix.app/plugins',
    changelog: 'https://motrix.app/changelog/',
    releaseNotes: 'https://motrix.app/release-notes/',
    manual: {
      home: 'https://motrix.app/manual/',
      natTroubleshooting: {
        en: 'https://motrix.app/manual/port-mapping/',
        zh: 'https://motrix.app/zh/manual/port-mapping/',
      },
      advancedProxy: 'https://motrix.app/manual/advanced-proxy',
      defaultApplication: 'https://motrix.app/manual/default-application',
    },
  },
} as const

export function getNatTroubleshootingUrl(language: string): string {
  const locale = language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return EXTERNAL_URLS.motrix.manual.natTroubleshooting[locale]
}
