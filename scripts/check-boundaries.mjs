import { spawnSync } from 'node:child_process'
import process from 'node:process'

const rules = [
  {
    label: 'core must not import electron',
    pattern: `from ['"]electron['"]`,
    dir: 'src/core/',
  },
  {
    label: 'core must not import fastify',
    pattern: `from ['"]@?fastify`,
    dir: 'src/core/',
  },
  {
    label: 'shared must not use Node-specific APIs or globals',
    pattern: `from ['"]node:|require\\(['"]node:|import\\(['"]node:|(^|[^[:alnum:]_$])process\\.|(^|[^[:alnum:]_$])NodeJS\\.`,
    dir: 'src/shared/',
  },
  {
    label: 'renderer must not import core or main',
    pattern: `from ['"][^'"]*(core|main)/`,
    dir: 'src/renderer/',
  },
  {
    label: 'server must not import electron',
    pattern: `from ['"]electron['"]`,
    dir: 'src/server/',
  },
  {
    label: 'server must not import src/main',
    pattern: `from ['"]@main/|from ['"][^'"]*src/main/`,
    dir: 'src/server/',
  },
  {
    label: 'production source must not reference deployment staging contracts',
    pattern: String.raw`(electron|server)-runtime-dependencies\.json|\.motrix-(package|server)-stage\.json|dist/(electron|server)-app`,
    dir: 'src/',
  },
  {
    label:
      'add-task UI must not import transport or protocol commands (except the IPC-aware hook/dialog/form)',
    pattern: `from ['"](@renderer/lib/transport|@shared/protocol/commands)['"]`,
    dir: 'src/renderer/components/add-task/',
    except: ['use-external-hydration.ts', 'drop-zone.tsx', 'add-task-form.tsx'],
  },
  {
    label: 'web-services must not reference Electron-only command symbols',
    pattern: `PickSaveDir|CloseCurrentWindow|ResizeWindow|ShowMainWindow`,
    dir: 'src/renderer/platform/web-services.ts',
  },
]

// grep -rn output lines are "path:line:content" — take the path prefix.
function filterOutExceptions(stdout, except) {
  if (!except || except.length === 0) return stdout
  const lines = stdout.split('\n').filter(Boolean)
  const kept = lines.filter((line) => {
    const filePath = line.split(':', 1)[0]
    return !except.some((suffix) => filePath.endsWith(suffix))
  })
  return kept.length > 0 ? `${kept.join('\n')}\n` : ''
}

let failed = 0
for (const rule of rules) {
  const res = spawnSync(
    'grep',
    ['-rnE', '--include=*.ts', '--include=*.tsx', rule.pattern, rule.dir],
    { encoding: 'utf8' }
  )
  const noMatch =
    res.status === 1 ||
    (res.status === 2 && res.stderr.includes('No such file'))
  if (noMatch) {
    console.log(`[PASS] ${rule.label}`)
    continue
  }
  if (res.status === 0) {
    const filtered = filterOutExceptions(res.stdout, rule.except)
    if (filtered === '') {
      console.log(`[PASS] ${rule.label}`)
      continue
    }
    console.log(`[FAIL] ${rule.label}`)
    process.stdout.write(filtered)
    failed++
    continue
  }
  console.log(`[ERROR] ${rule.label}: grep exited ${res.status}`)
  process.stderr.write(res.stderr)
  failed++
}

process.exit(failed > 0 ? 1 : 0)
