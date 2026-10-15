import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Regression guard for the "No runtime abstraction layer installed" bug.
//
// vscode-jsonrpc v9 requires a platform RAL to be installed before any
// MdxpConnection processes a message. The real extension installs the BROWSER
// RAL by importing the `@motrix/mdxp/browser` entry at SW startup
// (background/index.ts). Without it, the first inbound WS frame throws and the
// extension can never talk to Motrix.
//
// The e2e tests run under the NODE RAL (installed in src/__tests__/setup.ts),
// so they would NOT catch removal of the browser RAL import from the SW entry.
// This source-level check guards that exact regression.
describe('SW entry installs the browser RAL', () => {
  it('background/index.ts imports the @motrix/mdxp/browser entry', () => {
    // Vitest runs with cwd at the repository/package root.
    const src = readFileSync('src/background/service-worker.ts', 'utf8')
    expect(src).toMatch(/'@motrix\/mdxp\/browser'/)
  })
})
