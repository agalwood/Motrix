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
    name: 'base64',
    version: '0.22.1',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/marshallpierce/rust-base64',
  },
  {
    name: 'block-buffer',
    version: '0.10.4',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/utils',
  },
  {
    name: 'cfg-if',
    version: '1.0.4',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/cfg-if',
  },
  {
    name: 'cpufeatures',
    version: '0.2.17',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/utils',
  },
  {
    name: 'crypto-common',
    version: '0.1.7',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/traits',
  },
  {
    name: 'digest',
    version: '0.10.7',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/traits',
  },
  {
    name: 'generic-array',
    version: '0.14.7',
    license: 'MIT',
    repository: 'https://github.com/fizyk20/generic-array',
  },
  {
    name: 'hkdf',
    version: '0.12.4',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/KDFs',
  },
  {
    name: 'hmac',
    version: '0.12.1',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/MACs',
  },
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
    name: 'libc',
    version: '0.2.189',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/libc',
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
    name: 'sha2',
    version: '0.10.9',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/RustCrypto/hashes',
  },
  {
    name: 'subtle',
    version: '2.6.1',
    license: 'BSD-3-Clause',
    repository: 'https://github.com/dalek-cryptography/subtle',
  },
  {
    name: 'syn',
    version: '3.0.3',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/dtolnay/syn',
  },
  {
    name: 'typenum',
    version: '1.20.1',
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/paholg/typenum',
  },
  {
    name: 'unicode-ident',
    version: '1.0.24',
    license: '(MIT OR Apache-2.0) AND Unicode-3.0',
    repository: 'https://github.com/dtolnay/unicode-ident',
  },
  {
    name: 'version_check',
    version: '0.9.5',
    license: 'MIT/Apache-2.0',
    repository: 'https://github.com/SergioBenitez/version_check',
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
    file: 'rust-base64-LICENSE-APACHE',
    sha256: 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
  },
  {
    file: 'rust-base64-LICENSE-MIT',
    sha256: '0dd882e53de11566d50f8e8e2d5a651bcf3fabee4987d70f306233cf39094ba7',
  },
  {
    file: 'rust-block-buffer-LICENSE-APACHE',
    sha256: 'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5',
  },
  {
    file: 'rust-block-buffer-LICENSE-MIT',
    sha256: 'd5c22aa3118d240e877ad41c5d9fa232f9c77d757d4aac0c2f943afc0a95e0ef',
  },
  {
    file: 'rust-cfg-if-LICENSE-MIT',
    sha256: '378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
  },
  {
    file: 'rust-common-LICENSE-APACHE',
    sha256: '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
  },
  {
    file: 'rust-common-LICENSE-MIT',
    sha256: '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
  },
  {
    file: 'rust-cpufeatures-LICENSE-MIT',
    sha256: 'ae9baa7beea910273c2f384c2a6b721fb7bd02bda3436074a1072e4ee689f985',
  },
  {
    file: 'rust-crypto-common-LICENSE-MIT',
    sha256: '3521672491a3479422d5fe1aca6645dd2984090f85da6e5205abfb18fb7a6897',
  },
  {
    file: 'rust-digest-LICENSE-MIT',
    sha256: '9e0dfd2dd4173a530e238cb6adb37aa78c34c6bc7444e0e10c1ab5d8881f63ba',
  },
  {
    file: 'rust-generic-array-LICENSE-MIT',
    sha256: 'c09aae9d3c77b531f56351a9947bc7446511d6b025b3255312d3e3442a9a7583',
  },
  {
    file: 'rust-hkdf-LICENSE-APACHE',
    sha256: '59013a5c8d3a19c26a457579105915a5d51bb0c09d579f8cdedf12e4203c3018',
  },
  {
    file: 'rust-hkdf-LICENSE-MIT',
    sha256: 'd288f9c9b4590446ec18c22ead8f8b5a12a3d4025b68f62dc9015063eb9cca69',
  },
  {
    file: 'rust-humantime-LICENSE-MIT',
    sha256: 'f6deca8261a8f4a3403dc74c725c46051157fd36c27cd4b100277eb1f303ad11',
  },
  {
    file: 'rust-libc-LICENSE-MIT',
    sha256: '123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e',
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
    file: 'rust-sha2-LICENSE-MIT',
    sha256: 'b4eb00df6e2a4d22518fcaa6a2b4646f249b3a3c9814509b22bd2091f1392ff1',
  },
  {
    file: 'rust-subtle-LICENSE',
    sha256: 'd1fc1bc0d155df60b2e7705b6b2ae02a05c96f948e1cec6e2fb86360b09f346b',
  },
  {
    file: 'rust-typenum-LICENSE-APACHE',
    sha256: '516b24e051bf5630880ebbd55c40a25ce9552ebaf8970a53e8976eb70e522406',
  },
  {
    file: 'rust-typenum-LICENSE-MIT',
    sha256: 'a825bd853ab71619a4923d7b4311221427848070ff44d990da39b0b274c1683f',
  },
  {
    file: 'rust-unicode-ident-LICENSE-UNICODE',
    sha256: 'f7db81051789b729fea528a63ec4c938fdcb93d9d61d97dc8cc2e9df6d47f2a1',
  },
  {
    file: 'rust-version_check-LICENSE-MIT',
    sha256: 'b7e650f3fce5c53249d1cdc608b54df156a97edd636cf9d23498d0cfe7aec63e',
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
      expect(notice).toContain('1.37.0-motrix.11')
      expect(notice).toContain(
        'https://github.com/motrixapp/aria2/tree/v1.37.0-motrix.11'
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
      'LICENSE',
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
    expect(dockerfile).toContain('FROM ${' + 'NODE_IMAGE} AS deps')
    expect(dockerfile).toContain('FROM ${' + 'NODE_IMAGE} AS runtime')
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
