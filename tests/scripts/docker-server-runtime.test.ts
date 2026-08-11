import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

describe('Docker Server runtime staging contract', () => {
  it('copies only the verified stage into a non-root Node 24 runtime', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8')
    const runtime = dockerfile.slice(
      dockerfile.indexOf('FROM node:24-alpine AS runtime')
    )

    expect(runtime).toContain(
      'COPY --from=build --chown=node:node /app/dist/server-app/ ./'
    )
    expect(runtime.match(/^COPY /gm)).toHaveLength(1)
    expect(runtime).toContain('apk add --no-cache aria2 ca-certificates')
    expect(runtime).toContain('MOTRIX_ARIA2_BIN=/usr/bin/aria2c')
    expect(runtime).toContain('MOTRIX_DATA_DIR=/data')
    expect(runtime).toContain('MOTRIX_PLUGIN_DIR=/data/plugins')
    expect(runtime).toContain('MOTRIX_DEFAULT_SAVE_DIR=/downloads')
    expect(runtime).toContain('MOTRIX_ALLOWED_SAVE_DIRS=/downloads')
    expect(runtime).toContain('mkdir -p /data /downloads')
    expect(runtime).toContain('chown node:node /data /downloads')
    expect(runtime).toContain('VOLUME ["/data", "/downloads"]')
    expect(runtime).toContain('USER node')
    expect(runtime).toContain('CMD ["node", "dist/server/index.mjs"]')
    expect(runtime).toContain('rm -rf /usr/local/lib/node_modules/npm')
    expect(runtime).toContain('/usr/local/lib/node_modules/corepack')
    expect(runtime).toContain('/opt/yarn-v1.22.22')
    expect(runtime).not.toMatch(/\bpnpm (?:exec|install|run)\b/)
    expect(runtime).not.toContain('/app/src')
  })

  it('keeps required build inputs and excludes local-only context', async () => {
    const dockerignore = await readFile(
      path.join(ROOT, '.dockerignore'),
      'utf8'
    )

    for (const entry of [
      '.git',
      '.claude',
      '.codex',
      'dist',
      'release',
      'node_modules',
      'docs',
      'e2e',
      '**/*.test.ts',
      '**/*.test.tsx',
      'obsidian-docs.config.json',
    ]) {
      expect(dockerignore.split('\n')).toContain(entry)
    }
    expect(dockerignore).toContain('!tests/check-third-party-notices.test.ts')
    expect(dockerignore).toContain(
      '!tests/generate-third-party-notices.test.ts'
    )
  })

  it('keeps a corrected full-root comparison target without changing the final target', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8')
    const baselineStart = dockerfile.indexOf(
      'FROM node:24-alpine AS server-full-root-baseline'
    )
    const runtimeStart = dockerfile.indexOf('FROM node:24-alpine AS runtime')
    const baseline = dockerfile.slice(baselineStart, runtimeStart)

    expect(baselineStart).toBeGreaterThanOrEqual(0)
    expect(runtimeStart).toBeGreaterThan(baselineStart)
    expect(dockerfile).toContain(
      'FROM node:24-alpine AS full-root-production-deps'
    )
    expect(dockerfile).toContain(
      'pnpm install --prod --frozen-lockfile --ignore-scripts'
    )
    expect(baseline).toContain(
      'COPY --from=full-root-production-deps --chown=node:node /app/node_modules ./node_modules'
    )
    expect(baseline).toContain('/app/dist/core/plugin/host')
    expect(baseline).toContain('/app/build/legal/sbom.spdx.json')
    expect(
      dockerfile.trimEnd().endsWith('CMD ["node", "dist/server/index.mjs"]')
    ).toBe(true)
  })
})
