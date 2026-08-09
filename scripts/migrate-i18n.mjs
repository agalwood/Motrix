// scripts/migrate-i18n.mjs
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.join(here, '..', 'src', 'shared', 'locales')

// [oldPath, newPath, action]   action: 'rename' | 'delete'
const RENAMES = [
  ['settings.tracker.health', 'trackers.health', 'rename'],
  ['settings.tracker.source', 'trackers.source', 'rename'],
  ['settings.tracker.sync.syncing', 'trackers.sync.syncing', 'rename'],
  [
    'settings.tracker.sync.autoSync',
    'settings.bittorrent.trackers.autoSync',
    'rename',
  ],
  [
    'settings.tracker.sync.autoSyncDesc',
    'settings.bittorrent.trackers.autoSyncDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.syncInterval',
    'settings.bittorrent.trackers.syncInterval',
    'rename',
  ],
  [
    'settings.tracker.sync.syncIntervalDesc',
    'settings.bittorrent.trackers.syncIntervalDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.enableProbe',
    'settings.bittorrent.trackers.enableProbe',
    'rename',
  ],
  [
    'settings.tracker.sync.enableProbeDesc',
    'settings.bittorrent.trackers.enableProbeDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.probeTimeout',
    'settings.bittorrent.trackers.probeTimeout',
    'rename',
  ],
  [
    'settings.tracker.sync.probeTimeoutDesc',
    'settings.bittorrent.trackers.probeTimeoutDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.healthyThreshold',
    'settings.bittorrent.trackers.healthyThreshold',
    'rename',
  ],
  [
    'settings.tracker.sync.healthyThresholdDesc',
    'settings.bittorrent.trackers.healthyThresholdDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.minSuccessRate',
    'settings.bittorrent.trackers.minSuccessRate',
    'rename',
  ],
  [
    'settings.tracker.sync.minSuccessRateDesc',
    'settings.bittorrent.trackers.minSuccessRateDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.maxTrackerCount',
    'settings.bittorrent.trackers.maxTrackerCount',
    'rename',
  ],
  [
    'settings.tracker.sync.maxTrackerCountDesc',
    'settings.bittorrent.trackers.maxTrackerCountDesc',
    'rename',
  ],
  [
    'settings.tracker.sync.enableBlacklist',
    'settings.bittorrent.trackers.enableBlacklist',
    'rename',
  ],
  [
    'settings.tracker.sync.enableBlacklistDesc',
    'settings.bittorrent.trackers.enableBlacklistDesc',
    'rename',
  ],
  ['settings.tracker.sync.enableProxy', null, 'delete'],
  ['settings.tracker.sync.enableProxyDesc', null, 'delete'],
  ['settings.tracker.sync.proxyServer', null, 'delete'],
  ['settings.tracker.sync.proxyServerDesc', null, 'delete'],
  ['settings.tracker.sync.syncNow', null, 'delete'],
  ['settings.advanced.geoip', 'settings.bittorrent.geoip', 'rename'],
  ['settings.cards.tracker', null, 'delete'],
  ['settings.cards.download', 'settings.cards.downloads', 'rename'],
  ['settings.nav.tracker', null, 'delete'],
]

function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj)
}

function setByPath(obj, dotPath, value) {
  const keys = dotPath.split('.')
  const last = keys.pop()
  let target = obj
  for (const k of keys) {
    if (typeof target[k] !== 'object' || target[k] === null) target[k] = {}
    target = target[k]
  }
  target[last] = value
}

function deleteByPath(obj, dotPath) {
  const keys = dotPath.split('.')
  const last = keys.pop()
  let target = obj
  for (const k of keys) {
    target = target?.[k]
    if (!target) return
  }
  delete target[last]
}

function cleanEmpties(obj) {
  if (typeof obj !== 'object' || obj === null) return
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      cleanEmpties(obj[k])
      if (Object.keys(obj[k]).length === 0) delete obj[k]
    }
  }
}

async function migrate(file) {
  const json = JSON.parse(await readFile(file, 'utf-8'))
  for (const [oldPath, newPath, action] of RENAMES) {
    const value = getByPath(json, oldPath)
    if (value === undefined) continue
    deleteByPath(json, oldPath)
    if (action === 'rename') setByPath(json, newPath, value)
  }
  cleanEmpties(json)
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`migrated: ${path.relative(process.cwd(), file)}`)
}

await migrate(path.join(localesDir, 'en-US.json'))
await migrate(path.join(localesDir, 'zh-CN.json'))
console.log('i18n migration complete')
