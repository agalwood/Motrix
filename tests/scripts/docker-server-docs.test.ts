import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

async function text(file: string) {
  return readFile(path.join(ROOT, file), 'utf8')
}

describe('public Docker Server documentation', () => {
  it.each(['docs/docker-server.md', 'docs/docker-server.zh-CN.md'])(
    '%s covers the public NAS installation and lifecycle contract',
    async (file) => {
      const document = await text(file)

      for (const required of [
        'docker.io/motrixapp/motrix-server',
        'ghcr.io/agalwood/motrix-server',
        'linux/amd64',
        'linux/arm64',
        'stable',
        'latest',
        'compose.yaml',
        'compose.named-volumes.yaml',
        'compose.reverse-proxy.env',
        '/data',
        '/downloads',
        'MOTRIX_UID',
        'MOTRIX_GID',
        'operator-token',
        'motrix-admin pairing approve ABCD-EFGH',
        'MOTRIX_PUBLIC_URL',
        'MOTRIX_REMOTE_EXTENSION_ENABLED',
        'MOTRIX_REMOTE_EXTENSION_PUBLIC_URL',
        'MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP',
        'MOTRIX_WEB_BIND_IP',
        'MOTRIX_MDXP_BIND_IP',
        'MOTRIX_BIND_IP',
        'MOTRIX_ARIA2_RPC_LISTEN_ALL',
        '16800',
        '/mdxp/events',
        '/healthz',
        '/api/diagnostics',
        'DSM 7',
        'fnOS',
        'read-only',
        'HTTPS',
        'digest',
      ]) {
        expect(document, `${file} must mention ${required}`).toContain(required)
      }
      expect(document).not.toContain('docker compose up --build')
    }
  )

  it.each(['README.md', 'README.zh-CN.md'])(
    '%s uses the registry-first quick start',
    async (file) => {
      const document = await text(file)
      expect(document).toContain('docker compose pull server')
      expect(document).toContain('docker compose up -d --wait')
      expect(document).toContain('motrix-admin pairing approve ABCD-EFGH')
      expect(document).not.toContain('docker compose up --build')
    }
  )
})
