export interface HostPatternConformanceCase {
  name: string
  pattern: string
  url: string
  expected: boolean
}

/** Shared matcher corpus consumed by every policy seam. */
export const HOST_PATTERN_CONFORMANCE_CASES: readonly HostPatternConformanceCase[] =
  [
    {
      name: 'all urls includes HTTP',
      pattern: '<all_urls>',
      url: 'http://example.test/a',
      expected: true,
    },
    {
      name: 'all urls excludes FTP',
      pattern: '<all_urls>',
      url: 'ftp://example.test/a',
      expected: false,
    },
    {
      name: 'exact host rejects suffix confusion',
      pattern: 'https://allowed.example/*',
      url: 'https://allowed.example.evil/a',
      expected: false,
    },
    {
      name: 'path text is not an authority match',
      pattern: 'https://allowed.example/*',
      url: 'https://evil.example/allowed.example/a',
      expected: false,
    },
    {
      name: 'subdomain wildcard includes the suffix host',
      pattern: '*://*.example.test/*',
      url: 'https://example.test/a',
      expected: true,
    },
    {
      name: 'subdomain wildcard includes a real subdomain and arbitrary port',
      pattern: '*://*.example.test/*',
      url: 'http://api.example.test:49152/a',
      expected: true,
    },
    {
      name: 'exact manifest host matches an arbitrary explicit port',
      pattern: 'https://example.test/*',
      url: 'https://example.test:8443/a',
      expected: true,
    },
    {
      name: 'non-empty credentials fail closed',
      pattern: 'https://example.test/*',
      url: 'https://user:password@example.test/a',
      expected: false,
    },
    {
      name: 'empty userinfo fails closed before URL canonicalization',
      pattern: 'https://example.test/*',
      url: 'https://@example.test/a',
      expected: false,
    },
    {
      name: 'empty username and password fail closed',
      pattern: 'https://example.test/*',
      url: 'https://:@example.test/a',
      expected: false,
    },
    {
      name: 'IDNA and a trailing root dot canonicalize',
      pattern: 'https://bücher.example/*',
      url: 'https://xn--bcher-kva.example./a',
      expected: true,
    },
    {
      name: 'bracketed IPv6 matches exactly with an arbitrary port',
      pattern: 'http://[::1]/*',
      url: 'http://[::1]:39100/a',
      expected: true,
    },
    {
      name: 'query participates in path matching while fragment does not',
      pattern: 'https://example.test/download?token=*',
      url: 'https://example.test/download?token=abc#ignored',
      expected: true,
    },
    {
      name: 'percent-escape hex case normalizes without decoding',
      pattern: 'https://example.test/a%2Fb',
      url: 'https://example.test/a%2fb',
      expected: true,
    },
    {
      name: 'an encoded slash does not become a path separator',
      pattern: 'https://example.test/a/b',
      url: 'https://example.test/a%2fb',
      expected: false,
    },
  ]
