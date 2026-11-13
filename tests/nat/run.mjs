import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { prepareSource } from '../../scripts/build-taiji.mjs'
import { projectRoot, readEngineSource } from '../../scripts/engine-source.mjs'

const { values: options } = parseArgs({
  options: {
    performance: { type: 'boolean', default: false },
    baseline: { type: 'string' },
    samples: { type: 'string', default: '1' },
    cases: { type: 'string' },
  },
})
const samples = Number(options.samples)
if (!Number.isInteger(samples) || samples < 1 || samples > 10)
  throw new Error('samples must be between 1 and 10')
const info = await readEngineSource()
const source = await prepareSource(info, undefined, projectRoot)
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const output = path.join(projectRoot, 'output/taiji-nat-lab', stamp)
await mkdir(output, { recursive: true })
for (const name of ['fetching_lab.py', 'mapping_lab.py', 'performance_lab.py'])
  await copyFile(path.join(import.meta.dirname, name), path.join(output, name))
await build({
  entryPoints: [path.join(import.meta.dirname, 'mapping-agent.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(output, 'mapping-agent.cjs'),
})
const container = `motrix-nat-${process.pid}-${Date.now()}`
const image = 'motrix-taiji-fetching-nat:local'
const docker = (args) => execFileSync('docker', args, { stdio: 'inherit' })
docker(['build', '-t', image, import.meta.dirname])
try {
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--privileged',
    '--env',
    'MOTRIX_NAT_LAB=1',
    '--cpus=4',
    '--memory=6g',
    '--mount',
    `type=bind,source=${output},target=/work`,
    '--mount',
    `type=bind,source=${source},target=/src,readonly`,
    ...(options.baseline
      ? [
          '--mount',
          `type=bind,source=${path.resolve(options.baseline)},target=/baseline/taiji,readonly`,
        ]
      : []),
    image,
  ])
  const inside = (args) => docker(['exec', container, ...args])
  inside([
    'env',
    'CARGO_PROFILE_DEV_DEBUG=0',
    'cargo',
    'build',
    '--locked',
    '--manifest-path',
    '/src/Cargo.toml',
    '--target-dir',
    '/work/target',
    '-p',
    'taiji',
  ])
  for (const [enabled, name] of [
    ['false', 'holepunch-disabled'],
    ['true', 'holepunch-enabled'],
  ])
    inside([
      'python3',
      '/work/fetching_lab.py',
      '--hp',
      enabled,
      '--dest',
      `/work/${name}`,
    ])
  for (const mode of ['negative', 'positive'])
    inside(['python3', '/work/mapping_lab.py', mode])
  const cases = {}
  for (const name of [
    'holepunch-disabled',
    'holepunch-enabled',
    'mapping-negative',
    'mapping-positive',
  ])
    cases[name] = JSON.parse(
      await readFile(path.join(output, name, 'fetch/result.json'), 'utf8')
    )
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        revision: info.source.revision,
        patchSha256: info.source.patchSha256,
        topology:
          'two kernel SNAT routers with unsolicited ingress blocked; libtorrent peers; miniupnpd PCP/NAT-PMP',
        cases,
      },
      null,
      2
    )
  )
  if (options.performance) {
    inside([
      'python3',
      '/work/performance_lab.py',
      '--samples',
      String(samples),
      ...(options.baseline ? ['--baseline', '/baseline/taiji'] : []),
      ...(options.cases ? ['--cases', options.cases] : []),
    ])
  }
  console.log(`NAT verification passed. Evidence: ${output}`)
} finally {
  docker(['rm', '-f', container])
}
