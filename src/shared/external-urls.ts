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
  },
  motrix: {
    home: 'https://motrix.app/',
    acknowledgments: 'https://motrix.app/acknowledgments',
    plugins: 'https://motrix.app/plugins',
    changelog: 'https://motrix.app/changelog/',
    releaseNotes: 'https://motrix.app/release-notes/',
    manual: {
      home: 'https://motrix.app/manual/',
      advancedProxy: 'https://motrix.app/manual/advanced-proxy',
      defaultApplication: 'https://motrix.app/manual/default-application',
    },
  },
} as const
