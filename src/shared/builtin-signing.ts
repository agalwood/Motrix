// Build-time pinned trust root(s) for builtin plugin hot updates
// (2026-07-18 design §3). An ARRAY so a rotation can ship current+next
// keys ahead of re-signing; verification passes if any key matches.
// NEVER runtime-configurable.
export const BUILTIN_SIGNING_PUBKEYS: ReadonlyArray<string> = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbjfyCWHmZ8THA3nyliDdV6ADjXdVKAo5DBFlu8Vv6SY=
-----END PUBLIC KEY-----
`,
]
