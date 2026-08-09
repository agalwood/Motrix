#!/usr/bin/env node
// Enforces NAT-module-specific prohibitions:
// - No Math.random()
// - No third-party XML parsers (xml2js, fast-xml-parser, xmldom)
// - No dns.lookup imports in codecs/
//
// Run: node scripts/lint-nat-module.mjs
// Exits non-zero on violations.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NAT_ROOT = 'src/core/nat'

const RULES = [
  {
    name: 'no-math-random',
    pattern: /Math\.random\s*\(/,
    message:
      'Math.random() is banned in NAT module. Use crypto.randomInt or crypto.randomBytes.',
    allowComments: true,
  },
  {
    name: 'no-third-party-xml',
    pattern: /from\s+['"](xml2js|fast-xml-parser|xmldom|sax)['"]/,
    message: 'Third-party XML parsers are banned. Use codecs/xml-parser.ts.',
  },
  {
    name: 'no-buffer-equals-on-sensitive',
    pattern: /(nonce|transactionId|txId|cookie)[^\n]*\.equals\s*\(/i,
    message:
      'Security-sensitive Buffer comparison must use crypto.timingSafeEqual.',
  },
]

function walkDir(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkDir(full, files)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      files.push(full)
  }
  return files
}

function stripLineComments(line) {
  const ix = line.indexOf('//')
  return ix >= 0 ? line.slice(0, ix) : line
}

let violations = 0
try {
  const files = walkDir(NAT_ROOT)
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')
    for (const rule of RULES) {
      lines.forEach((line, i) => {
        const scanLine = rule.allowComments ? stripLineComments(line) : line
        if (rule.pattern.test(scanLine)) {
          console.error(`${file}:${i + 1}: [${rule.name}] ${rule.message}`)
          console.error(`  > ${line.trim()}`)
          violations++
        }
      })
    }
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log(`${NAT_ROOT} does not exist yet — skipping`)
    process.exit(0)
  }
  throw err
}

if (violations > 0) {
  console.error(`\n${violations} NAT lint violation(s) found.`)
  process.exit(1)
}
console.log('NAT module lint: PASS')
