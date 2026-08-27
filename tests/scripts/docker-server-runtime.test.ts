import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSmokeContainerIdentity } from '../../scripts/smoke-server-identity.mjs'
// @ts-expect-error -- JavaScript smoke helper intentionally has no declarations
import {
  resolveSmokeMode,
  resolveSmokePlatform,
} from '../../scripts/smoke-server-platform.mjs'

const ROOT = process.cwd()
const NODE_IMAGE_REFERENCE = '$' + '{NODE_IMAGE}'
const PATH_REFERENCE = '$' + '{PATH}'
const ENGINE_ARCH_REFERENCE = '$' + '{engine_arch}'

describe('Docker Server runtime staging contract', () => {
  it('limits explicit publication smoke to supported Linux architectures', () => {
    expect(resolveSmokePlatform(undefined)).toBeUndefined()
    expect(resolveSmokePlatform('linux/amd64')).toBe('linux/amd64')
    expect(resolveSmokePlatform('linux/arm64')).toBe('linux/arm64')
    expect(() => resolveSmokePlatform('linux/386')).toThrow(/unsupported/)
  })

  it('defaults image smoke to full and accepts a cross-architecture health mode', () => {
    expect(resolveSmokeMode(undefined)).toBe('full')
    expect(resolveSmokeMode('full')).toBe('full')
    expect(resolveSmokeMode('health')).toBe('health')
    expect(() => resolveSmokeMode('package-only')).toThrow(/unsupported/)
  })

  it('maps smoke containers to a portable non-root host identity', () => {
    expect(resolveSmokeContainerIdentity(1001, 121)).toEqual({
      uid: 1001,
      gid: 121,
      user: '1001:121',
    })
    expect(resolveSmokeContainerIdentity(0, 0)).toEqual({
      uid: 1000,
      gid: 1000,
      user: '1000:1000',
    })
    expect(resolveSmokeContainerIdentity(Number.NaN, Number.NaN)).toEqual({
      uid: 1000,
      gid: 1000,
      user: '1000:1000',
    })
  })

  it('copies only the verified stage into a non-root Node 24 runtime', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8')
    const runtime = dockerfile.slice(
      dockerfile.indexOf(`FROM ${NODE_IMAGE_REFERENCE} AS runtime`)
    )

    expect(dockerfile).toMatch(
      /^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}$/m
    )
    expect(dockerfile).toMatch(
      /^ARG NODE_IMAGE=node:24-alpine@sha256:[0-9a-f]{64}$/m
    )
    expect(runtime).toContain(
      'COPY --from=build --chown=node:node /app/dist/server-app/ ./'
    )
    expect(runtime).toContain(
      'exec node /app/dist/server/motrix-admin.mjs "$@"'
    )
    expect(runtime).toContain('chmod 0755 /usr/local/bin/motrix-admin')
    expect(runtime.match(/^COPY /gm)).toHaveLength(1)
    expect(runtime).toContain('apk add --no-cache ca-certificates')
    expect(runtime).not.toContain('apk add --no-cache aria2')
    expect(runtime).toContain(`PATH=/app/bin:${PATH_REFERENCE}`)
    expect(runtime).toContain('MOTRIX_ARIA2_BIN=/app/bin/aria2c')
    expect(runtime).toContain(
      'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt'
    )
    expect(runtime).toContain('MOTRIX_DATA_DIR=/data')
    expect(runtime).toContain('MOTRIX_PLUGIN_DIR=/data/plugins')
    expect(runtime).toContain('MOTRIX_DEFAULT_SAVE_DIR=/downloads')
    expect(runtime).toContain('MOTRIX_ALLOWED_SAVE_DIRS=/downloads')
    expect(runtime).toContain('mkdir -p /data/home /data/tmp /downloads')
    expect(runtime).toContain('chown -R node:node /data /downloads')
    expect(runtime).toContain('VOLUME ["/data", "/downloads"]')
    expect(runtime).toContain('MOTRIX_TEMP_DIR=/data/tmp')
    expect(runtime).toContain('TMPDIR=/data/tmp')
    expect(runtime).toContain('HOME=/data/home')
    expect(runtime).toContain('USER node')
    expect(runtime).toContain('STOPSIGNAL SIGTERM')
    expect(runtime).toContain('HEALTHCHECK --interval=30s')
    expect(runtime).toContain('CMD ["node", "dist/server/index.mjs"]')
    expect(runtime).toContain('ARG OCI_REVISION=unknown')
    expect(runtime).toContain('ARG OCI_VERSION=0.0.0-local')
    for (const label of [
      'org.opencontainers.image.title',
      'org.opencontainers.image.description',
      'org.opencontainers.image.url',
      'org.opencontainers.image.documentation',
      'org.opencontainers.image.source',
      'org.opencontainers.image.revision',
      'org.opencontainers.image.version',
      'org.opencontainers.image.licenses',
    ]) {
      expect(runtime).toContain(label)
    }
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
      '.obsidian-doc-context.json',
      '.obsidian-doc-context.json.tmp-*',
    ]) {
      expect(dockerignore.split('\n')).toContain(entry)
    }
    expect(dockerignore).toContain('!tests/check-third-party-notices.test.ts')
    expect(dockerignore).toContain(
      '!tests/generate-third-party-notices.test.ts'
    )
  })

  it('exercises deployment behavior instead of only process startup', async () => {
    const imageSmoke = await readFile(
      path.join(ROOT, 'scripts/smoke-server-image.mjs'),
      'utf8'
    )

    expect(imageSmoke).toContain("'--read-only'")
    expect(imageSmoke).toContain(
      "if (platform) await docker(['pull', '--platform', platform, image])"
    )
    expect(imageSmoke).toContain("await docker(['image', 'inspect', image])")
    expect(imageSmoke).not.toContain(
      "docker(['image', 'inspect', ...platformArgs(platform), image])"
    )
    expect(imageSmoke).toContain(
      "metadata.Architecture !== platform.split('/')[1]"
    )
    expect(imageSmoke).toContain("method: 'aria2.tellActive'")
    expect(imageSmoke).toContain("download.status === 'active'")
    expect(imageSmoke).toContain(
      'download.completedLength === download.totalLength'
    )
    expect(imageSmoke).toContain("'--enable-rpc=true'")
    expect(imageSmoke).toContain(
      'await waitForSeeder(seedName, seederRpcSecret, timeoutMs)'
    )
    expect(imageSmoke).toContain(
      'await assertSeederReachable(appName, seedIp, timeoutMs)'
    )
    expect(
      imageSmoke.indexOf(
        'await waitForSeeder(seedName, seederRpcSecret, timeoutMs)'
      )
    ).toBeLessThan(imageSmoke.indexOf('fixtureServer.setTrackerPeer'))
    expect(imageSmoke.indexOf("'command:setTaskBtTracker'")).toBeGreaterThan(
      imageSmoke.indexOf("new Set(['seeding', 'completed'])")
    )
    expect(imageSmoke).toContain('engineGid: finalBtTask.engineTaskId')
    expect(imageSmoke).toContain(
      "path.join(volumes.downloadsDir, 'sample-data', 'test.bin')"
    )
    expect(imageSmoke).not.toContain("'sample-data', 'sample-data', 'test.bin'")
    expect(imageSmoke).toContain("randomBytes(24).toString('hex')")
    expect(imageSmoke).toContain('downloadedBytes: lastTask.downloadedBytes')
    expect(imageSmoke).toContain('totalBytes: lastTask.totalBytes')
    expect(imageSmoke).toContain('Fixture tracker: announces=')
    expect(imageSmoke).toContain('identity.user')
    expect(imageSmoke).toContain("'command:createTask'")
    expect(imageSmoke).toContain("'command:setTaskBtTracker'")
    expect(imageSmoke).toContain("'command:installPlugin'")
    expect(imageSmoke).toContain("'command:uninstallPlugin'")
    expect(imageSmoke).toContain("'motrix-admin'")
    expect(imageSmoke).toContain("'pairing'")
    expect(imageSmoke).toContain("'pending'")
    expect(imageSmoke).toContain('Save directory is not writable: /downloads')
    expect(imageSmoke).toContain('did not survive container restart')
    expect(imageSmoke).toContain("'SQLite3-Persistence'")
    expect(imageSmoke).toContain("'test -s /app/LICENSE'")
    expect(imageSmoke).toContain("'test ! -e /usr/bin/aria2c'")
    expect(imageSmoke).toContain(
      '\'test "$(readlink /proc/$aria2_pid/exe)" = "/app/bin/aria2c"\''
    )
    expect(imageSmoke).toContain('motrixAria2Fork: true')
  })

  it('keeps a corrected full-root comparison target without changing the final target', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8')
    const baselineStart = dockerfile.indexOf(
      `FROM ${NODE_IMAGE_REFERENCE} AS server-full-root-baseline`
    )
    const runtimeStart = dockerfile.indexOf(
      `FROM ${NODE_IMAGE_REFERENCE} AS runtime`
    )
    const baseline = dockerfile.slice(baselineStart, runtimeStart)

    expect(baselineStart).toBeGreaterThanOrEqual(0)
    expect(runtimeStart).toBeGreaterThan(baselineStart)
    expect(dockerfile).toContain(
      `FROM ${NODE_IMAGE_REFERENCE} AS full-root-production-deps`
    )
    expect(dockerfile).toContain(
      'pnpm install --prod --frozen-lockfile --ignore-scripts'
    )
    expect(dockerfile).toContain(
      `node scripts/fetch-engine.mjs --platform linux --arch "${ENGINE_ARCH_REFERENCE}"`
    )
    expect(dockerfile).toContain('amd64) engine_arch=x64')
    expect(dockerfile).toContain('arm64) engine_arch=arm64')
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
