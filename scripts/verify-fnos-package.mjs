import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import lock from './fnos-runtime.lock.json' with { type: 'json' }
import {
  FNOS_ARCHITECTURES,
  sha256,
  verifyFnosBinary,
} from './prepare-fnos-project.mjs'
import { verifyServerPackage } from './verify-server-package.mjs'

export async function verifyFnosPackage(projectDir, arch) {
  const target = FNOS_ARCHITECTURES[arch]
  if (!target) throw new Error('Unsupported fnOS architecture')
  const readJson = async (file) =>
    JSON.parse(await readFile(path.join(projectDir, file), 'utf8'))
  const manifest = Object.fromEntries(
    (await readFile(path.join(projectDir, 'manifest'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=').map((part) => part.trim()))
  )
  const receipt = await readJson('app/fnos-build.json')
  if (
    manifest.appname !== 'motrix' ||
    manifest.platform !== target.platform ||
    manifest.version !== receipt.version ||
    manifest.os_min_version !== '1.2.0401' ||
    manifest.micro_app !== 'true'
  )
    throw new Error('Inconsistent fnOS manifest')
  const privilege = await readJson('config/privilege')
  if (
    privilege.defaults?.['run-as'] !== 'package' ||
    Object.keys(privilege).some(
      (key) => !['defaults', 'username', 'groupname'].includes(key)
    )
  )
    throw new Error('fnOS must run as its package user')
  const entries = (await readJson('app/ui/config'))['.url']
  for (const entry of Object.values(entries)) {
    if (
      entry.gatewayPrefix !== '/app/motrix' ||
      entry.gatewaySocket !== 'app.sock' ||
      entry.allUsers !== false ||
      entry.url !== '/app/motrix/'
    )
      throw new Error('Invalid fnOS gateway entry')
  }
  for (const script of [
    'main',
    'install_init',
    'install_callback',
    'upgrade_init',
    'upgrade_callback',
    'uninstall_init',
    'uninstall_callback',
    'config_init',
    'config_callback',
  ]) {
    if (!((await stat(path.join(projectDir, 'cmd', script))).mode & 0o111))
      throw new Error(`Non-executable fnOS callback: ${script}`)
  }
  for (const file of await readdir(path.join(projectDir, 'wizard')))
    await readJson(`wizard/${file}`)
  await readJson('config/resource')
  for (const [file, size] of [
    ['ICON.PNG', 64],
    ['ICON_256.PNG', 256],
    ['app/ui/images/icon_64.png', 64],
    ['app/ui/images/icon_256.png', 256],
  ]) {
    const data = await readFile(path.join(projectDir, file))
    if (data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size)
      throw new Error(`Invalid fnOS icon dimensions: ${file}`)
  }
  const node = path.join(projectDir, 'app/runtime/bin/node')
  await verifyFnosBinary(node, arch)
  if (
    receipt.arch !== arch ||
    receipt.nodeVersion !== lock.nodeVersion ||
    receipt.nodeArchiveSha256 !== lock.node[arch].sha256 ||
    receipt.nodeSha256 !== sha256(await readFile(node))
  )
    throw new Error('fnOS Node runtime integrity mismatch')
  if (
    !(
      await readFile(path.join(projectDir, 'app/runtime/LICENSE'), 'utf8')
    ).includes('Node.js')
  )
    throw new Error('Node license is missing')
  const html = await readFile(
    path.join(projectDir, 'app/server/dist/renderer-web/index.html'),
    'utf8'
  )
  if (!html.includes('name="motrix-integration" content="fnos"'))
    throw new Error('Build the Web UI with MOTRIX_FNOS_BUILD=1')
  if (/\b(?:src|href)=["']\/assets\//.test(html))
    throw new Error('Web assets must be relative for the fnOS gateway')
  await verifyServerPackage({
    appDir: path.join(projectDir, 'app/server'),
    platform: 'linux',
    arch,
    libc: 'gnu',
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      'project-dir': { type: 'string' },
      arch: { type: 'string', default: process.arch },
    },
  })
  verifyFnosPackage(
    values['project-dir'] ?? `release/fnos/${values.arch}`,
    values.arch
  )
    .then(() => console.log('fnOS package verified'))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
