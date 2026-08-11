import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const NATIVE_HOST_CARGO_LOCK = path.join(
  ROOT,
  'packages/native-host/Cargo.lock'
)
const NOTICE_GATE_COMMAND = 'pnpm run check:third-party-notices'
const FLATPAK_NOTICE_GATE_COMMAND =
  'pnpm --config.verify-deps-before-run=false run check:third-party-notices'
const LEGAL_ARTIFACTS = [
  'THIRD_PARTY_DEPENDENCIES.md',
  'THIRD_PARTY_LICENSES.txt',
  'sbom.spdx.json',
] as const
const require = createRequire(import.meta.url)
const parseYaml = require('js-yaml').load as (source: string) => unknown

interface RustCrateNotice {
  name: string
  version: string
  license: string
  repository: string
}

const RUST_NATIVE_HOST_CRATES: RustCrateNotice[] = [
  {
    name: 'home',
    version: '0.5.12',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/cargo',
  },
  {
    name: 'humantime',
    version: '2.4.0',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/chronotope/humantime',
  },
  {
    name: 'itoa',
    version: '1.0.18',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/dtolnay/itoa',
  },
  {
    name: 'memchr',
    version: '2.8.3',
    license: 'Unlicense OR MIT',
    repository: 'https://github.com/BurntSushi/memchr',
  },
  {
    name: 'proc-macro2',
    version: '1.0.107',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/dtolnay/proc-macro2',
  },
  {
    name: 'quote',
    version: '1.0.47',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/dtolnay/quote',
  },
  {
    name: 'serde',
    version: '1.0.229',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/serde-rs/serde',
  },
  {
    name: 'serde_core',
    version: '1.0.229',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/serde-rs/serde',
  },
  {
    name: 'serde_derive',
    version: '1.0.229',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/serde-rs/serde',
  },
  {
    name: 'serde_json',
    version: '1.0.151',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/serde-rs/json',
  },
  {
    name: 'syn',
    version: '3.0.3',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/dtolnay/syn',
  },
  {
    name: 'unicode-ident',
    version: '1.0.24',
    license: '(MIT OR Apache-2.0) AND Unicode-3.0',
    repository: 'https://github.com/dtolnay/unicode-ident',
  },
  {
    name: 'windows-link',
    version: '0.2.1',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/microsoft/windows-rs',
  },
  {
    name: 'windows-sys',
    version: '0.61.2',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/microsoft/windows-rs',
  },
  {
    name: 'zmij',
    version: '1.0.23',
    license: 'MIT',
    repository: 'https://github.com/dtolnay/zmij',
  },
]

const RUST_LICENSE_FILES = [
  {
    file: 'rust-common-LICENSE-APACHE',
    sha256: '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
  },
  {
    file: 'rust-common-LICENSE-MIT',
    sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
  },
  {
    file: 'rust-humantime-LICENSE-MIT',
    sha256: 'f6deca8261a8f4a3403dc74c725c46051157fd36c27cd4b100277eb1f303ad11',
  },
  {
    file: 'rust-memchr-COPYING',
    sha256: '01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f',
  },
  {
    file: 'rust-memchr-LICENSE-MIT',
    sha256: '0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f',
  },
  {
    file: 'rust-memchr-UNLICENSE',
    sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  },
  {
    file: 'rust-unicode-ident-LICENSE-UNICODE',
    sha256: 'f7db81051789b729fea528a63ec4c938fdcb93d9d61d97dc8cc2e9df6d47f2a1',
  },
  {
    file: 'rust-windows-rs-LICENSE-MIT',
    sha256: 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383',
  },
] as const

interface FlatpakModule {
  name?: string
  'build-commands'?: string[]
}

interface FlatpakManifest {
  modules?: FlatpakModule[]
}

function namedStep(workflow: string, name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`)
  if (start === -1) return ''
  const next = workflow.indexOf('\n      - name:', start + 1)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

function dockerStageRunCommands(
  dockerfile: string,
  stageName: string
): string[] {
  const logicalLines = dockerfile
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

  const commands: string[] = []
  let currentStage = ''
  for (const line of logicalLines) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?$/i.exec(line)
    if (from) {
      currentStage = from[1] ?? ''
      continue
    }
    if (currentStage !== stageName || !/^RUN\s+/i.test(line)) continue
    commands.push(
      ...line
        .replace(/^RUN\s+/i, '')
        .split(/\s*&&\s*/)
        .map((command) => command.trim())
    )
  }
  return commands
}

function isProductionOnlyInstall(command: string): boolean {
  return /(?:^|\s)--(?:prod|production)(?:\s|$|=)/.test(command)
}

function registryPackagesFromCargoLock(
  source: string
): Array<{ name: string; version: string }> {
  return source
    .split('[[package]]')
    .slice(1)
    .flatMap((block) => {
      const name = /^name = "([^"]+)"$/m.exec(block)?.[1]
      const version = /^version = "([^"]+)"$/m.exec(block)?.[1]
      const packageSource = /^source = "([^"]+)"$/m.exec(block)?.[1]
      if (
        name === undefined ||
        version === undefined ||
        !packageSource?.startsWith('registry+')
      ) {
        return []
      }
      return [{ name, version }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

describe('third-party graph dependency notices', () => {
  it('keeps the root manifest as the legal dependency source of truth', async () => {
    const generator = await readFile(
      path.join(ROOT, 'scripts/generate-third-party-notices.mjs'),
      'utf8'
    )

    expect(generator).toContain("path.join(resolvedProjectDir, 'package.json')")
    expect(generator).not.toContain('dist/electron-app/package.json')
  })

  it.each(['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md'])(
    '%s documents the generated runtime inventory',
    async (noticeFile) => {
      const notice = await readFile(path.join(ROOT, noticeFile), 'utf8')

      expect(notice).toContain('scripts/third-party-notices.config.json')
      expect(notice).toContain('THIRD_PARTY_DEPENDENCIES.md')
      expect(notice).toContain('THIRD_PARTY_LICENSES.txt')
      expect(notice).toContain('sbom.spdx.json')
    }
  )

  it.each(['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md'])(
    '%s records aria2 and the retained Apple tray font',
    async (noticeFile) => {
      const notice = await readFile(path.join(ROOT, noticeFile), 'utf8')

      expect(notice).toContain('SFNS-Regular.ttf')
      expect(notice).toContain('https://developer.apple.com/fonts/')
      expect(notice).toContain('1.37.0-motrix.3')
      expect(notice).toContain(
        'https://github.com/motrixapp/aria2/tree/v1.37.0-motrix.3'
      )
      expect(notice).toContain('GPL-2.0-or-later')
      expect(notice).toContain('THIRD_PARTY_LICENSES/aria2-COPYING')
      expect(notice).toContain('THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL')
    }
  )

  it('tracks every registry crate locked into the native host', async () => {
    const cargoLock = await readFile(NATIVE_HOST_CARGO_LOCK, 'utf8')
    const expected = RUST_NATIVE_HOST_CRATES.map(({ name, version }) => ({
      name,
      version,
    }))

    expect(registryPackagesFromCargoLock(cargoLock)).toEqual(expected)
  })

  it.each(['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md'])(
    '%s records every locked native-host crate and SPDX expression',
    async (noticeFile) => {
      const notice = await readFile(path.join(ROOT, noticeFile), 'utf8')

      for (const crate of RUST_NATIVE_HOST_CRATES) {
        expect(notice).toContain(
          `| ${crate.name} | ${crate.version} | \`${crate.license}\` | <${crate.repository}> |`
        )
      }
      for (const license of RUST_LICENSE_FILES) {
        expect(notice).toContain(`THIRD_PARTY_LICENSES/${license.file}`)
      }
    }
  )

  it('vendors the locked Rust license texts byte-for-byte', async () => {
    const digests = await Promise.all(
      RUST_LICENSE_FILES.map(async ({ file }) => {
        const bytes = await readFile(
          path.join(ROOT, 'THIRD_PARTY_LICENSES', file)
        )
        return createHash('sha256').update(bytes).digest('hex')
      })
    )

    expect(digests).toEqual(RUST_LICENSE_FILES.map(({ sha256 }) => sha256))
  })

  it('distributes notices, licenses, and generated compliance files with every Electron build', async () => {
    const config = JSON.parse(
      await readFile(path.join(ROOT, 'electron-builder.json'), 'utf8')
    ) as {
      extraResources?: Array<{
        from?: string
        to?: string
        filter?: string[]
      }>
    }
    const sources =
      config.extraResources?.map((resource) => resource.from) ?? []

    expect(sources).toContain('./THIRD_PARTY_NOTICES.md')
    expect(sources).toContain('./THIRD_PARTY_NOTICES.zh-CN.md')
    expect(sources).toContain('./THIRD_PARTY_LICENSES')
    expect(sources).toContain('./build/legal')
    expect(
      config.extraResources?.find(
        (resource) => resource.from === './build/legal'
      )
    ).toEqual({
      from: './build/legal',
      to: './legal',
      filter: [...LEGAL_ARTIFACTS],
    })

    const macResources = JSON.parse(
      await readFile(path.join(ROOT, 'electron-builder.json'), 'utf8')
    ) as {
      mac?: { extraResources?: Array<{ filter?: string[] }> }
    }
    expect(
      macResources.mac?.extraResources?.some((resource) =>
        resource.filter?.includes('SFNS-Regular.ttf')
      )
    ).toBe(true)
  })

  it('delivers the verified staged legal payload into the Docker runtime image', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8')

    expect(dockerfile).toContain(
      'COPY --from=build --chown=node:node /app/dist/server-app/ ./'
    )
    for (const artifact of LEGAL_ARTIFACTS) {
      const contract = JSON.parse(
        await readFile(
          path.join(ROOT, 'scripts/server-runtime-dependencies.json'),
          'utf8'
        )
      ) as { resourceInputs?: Array<{ destination?: string }> }
      expect(
        contract.resourceInputs?.map((input) => input.destination)
      ).toContain(`legal/${artifact}`)
    }
    for (const destination of [
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_NOTICES.zh-CN.md',
      'THIRD_PARTY_LICENSES',
    ]) {
      const contract = JSON.parse(
        await readFile(
          path.join(ROOT, 'scripts/server-runtime-dependencies.json'),
          'utf8'
        )
      ) as { resourceInputs?: Array<{ destination?: string }> }
      expect(
        contract.resourceInputs?.map((input) => input.destination)
      ).toContain(destination)
    }
    expect(dockerfile).toContain(
      'node scripts/verify-server-package.mjs --app-dir dist/server-app'
    )
    expect(dockerfile).not.toMatch(
      /COPY --from=build \/app\/(?:THIRD_PARTY|build\/legal)/
    )
    expect(dockerfile).not.toContain(
      'COPY --from=runtime-deps /app/node_modules ./node_modules'
    )
  })

  it('gates and stages the canonical Docker build before runtime delivery', async () => {
    const [dockerfile, manifestSource] = await Promise.all([
      readFile(path.join(ROOT, 'Dockerfile'), 'utf8'),
      readFile(path.join(ROOT, 'package.json'), 'utf8'),
    ])
    const manifest = JSON.parse(manifestSource) as {
      devDependencies?: Record<string, string>
    }
    const depsCommands = dockerStageRunCommands(dockerfile, 'deps')
    const buildCommands = dockerStageRunCommands(dockerfile, 'build')
    const installCommand = depsCommands.find((command) =>
      /^pnpm install(?:\s|$)/.test(command)
    )
    const electronInstallIndex = buildCommands.indexOf(
      'node node_modules/electron/install.js'
    )
    const gateIndex = buildCommands.findIndex((command) =>
      command.endsWith(NOTICE_GATE_COMMAND)
    )
    const buildIndex = buildCommands.findIndex((command) =>
      /^pnpm (?:run )?build:server(?:\s|$)/.test(command)
    )
    const stageIndex = buildCommands.findIndex((command) =>
      command.startsWith('node scripts/stage-server-app.mjs ')
    )
    const verifyIndex = buildCommands.findIndex((command) =>
      command.startsWith('node scripts/verify-server-package.mjs ')
    )

    expect(manifest.devDependencies?.vitest).toBeDefined()
    expect(installCommand).toBeDefined()
    expect(isProductionOnlyInstall(installCommand ?? '')).toBe(false)
    expect(dockerfile).toContain('FROM node:24-alpine AS deps')
    expect(dockerfile).toContain('FROM node:24-alpine AS runtime')
    expect(electronInstallIndex).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeGreaterThan(electronInstallIndex)
    expect(buildIndex).toBeGreaterThan(gateIndex)
    expect(stageIndex).toBeGreaterThan(buildIndex)
    expect(verifyIndex).toBeGreaterThan(stageIndex)
    expect(dockerfile).not.toContain('pnpm prune --prod')
    expect(dockerfile).not.toContain('FROM build AS runtime-deps')
    expect(dockerfile).toContain(
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./'
    )
    expect(dockerfile).toContain(
      'COPY packages/native-host/package.json ./packages/native-host/package.json'
    )
    expect(dockerfile).toContain(
      'node scripts/stage-server-app.mjs --platform linux --arch "${' +
        'TARGETARCH}" --libc musl --strict'
    )
    expect(dockerfile).toContain('USER node')
  })

  it('gates the canonical Flatpak build before rebuild and packaging', async () => {
    const [manifestSource, packageSource] = await Promise.all([
      readFile(path.join(ROOT, 'flatpak/app.motrix.native.yml'), 'utf8'),
      readFile(path.join(ROOT, 'package.json'), 'utf8'),
    ])
    const manifest = parseYaml(manifestSource) as FlatpakManifest
    const packageManifest = JSON.parse(packageSource) as {
      devDependencies?: Record<string, string>
    }
    const module = manifest.modules?.find(
      (candidate) => candidate.name === 'motrix'
    )
    const commands = module?.['build-commands'] ?? []
    const installIndex = commands.findIndex((command) =>
      /^pnpm install(?:\s|$)/.test(command)
    )
    const gateIndex = commands.indexOf(FLATPAK_NOTICE_GATE_COMMAND)
    const deliveryIndexes = commands.flatMap((command, index) =>
      /(?:^|\s)(?:electron-rebuild|electron-builder)(?:\s|$)|^pnpm run build(?:\s|$)/.test(
        command
      )
        ? [index]
        : []
    )

    expect(packageManifest.devDependencies?.vitest).toBeDefined()
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(isProductionOnlyInstall(commands[installIndex] ?? '')).toBe(false)
    expect(gateIndex).toBeGreaterThan(installIndex)
    expect(deliveryIndexes.length).toBeGreaterThan(0)
    for (const deliveryIndex of deliveryIndexes) {
      expect(deliveryIndex).toBeGreaterThan(gateIndex)
    }
  })

  it('gates every package script that can package the application', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}

    expect(scripts['build:electron']).toMatch(/^pnpm run build:legal && /)
    expect(scripts['build:server']).toMatch(
      /^pnpm run build:builtin && pnpm run build:legal && /
    )
    expect(scripts['check:third-party-notices']).toContain(
      'node scripts/generate-third-party-notices.mjs --check'
    )
    expect(scripts['check:third-party-notices']).toContain(
      'vitest run tests/check-third-party-notices.test.ts tests/generate-third-party-notices.test.ts'
    )
    expect(scripts['check:third-party-notices']).not.toContain(
      NOTICE_GATE_COMMAND
    )

    const packagingEntries = Object.entries(scripts).filter(
      ([name, command]) =>
        /^(?:pack|dist|release):/.test(name) ||
        /(?:^|\s)electron-builder(?:\s|$)/.test(command) ||
        /(?:^|\s)flatpak-builder(?:\s|$)/.test(command)
    )
    expect(packagingEntries.map(([name]) => name).sort()).toEqual([
      'dist:mac',
      'pack:mac',
      'release:mac',
    ])
    for (const [name, command] of packagingEntries) {
      expect(
        command,
        `${name} must block on the unified third-party notice gate`
      ).toMatch(/^pnpm run check:third-party-notices && /)
    }
  })

  it.each([
    ['CI', '.github/workflows/ci.yml'],
    ['release', '.github/workflows/release.yml'],
    ['Flatpak', '.github/workflows/flatpak.yml'],
  ])(
    '%s blocks on the notice contract before delivery',
    async (_label, file) => {
      const workflow = await readFile(path.join(ROOT, file), 'utf8')
      const step = namedStep(workflow, 'Third-party notice contract')

      expect(step).toContain(
        `run: ${
          file.endsWith('flatpak.yml')
            ? FLATPAK_NOTICE_GATE_COMMAND
            : NOTICE_GATE_COMMAND
        }`
      )
      expect(step).not.toContain('continue-on-error')
      expect(step).not.toContain('if:')

      if (file.endsWith('release.yml')) {
        const gateIndex = workflow.indexOf(
          '      - name: Third-party notice contract'
        )
        expect(gateIndex).toBeLessThan(workflow.indexOf('      - name: Build'))
        expect(gateIndex).toBeLessThan(
          workflow.indexOf('      - name: Electron Builder')
        )
        expect(gateIndex).toBeLessThan(
          workflow.indexOf('      - name: Publish validated GitHub Release')
        )
      }

      if (file.endsWith('flatpak.yml')) {
        const gateIndex = workflow.indexOf(
          '      - name: Third-party notice contract'
        )
        expect(gateIndex).toBeGreaterThan(
          workflow.indexOf('      - name: Install dependencies')
        )
        expect(gateIndex).toBeLessThan(
          workflow.indexOf('      - name: Generate Flatpak npm sources')
        )
        expect(gateIndex).toBeLessThan(
          workflow.indexOf('      - name: Build Flatpak bundle')
        )
      }
    }
  )
})
