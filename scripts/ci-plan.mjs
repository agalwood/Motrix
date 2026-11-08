import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const PACKAGE_TARGETS = JSON.parse(
  readFileSync(new URL('../.github/ci-package-targets.json', import.meta.url))
)
const UI_TARGETS = new Set(['linux-x64', 'win32-x64', 'darwin-arm64'])

// Only presentation files qualify for the reduced platform matrix. Transport,
// shared contracts, dependencies, build inputs and unknown paths stay full.
export function isPresentationPath(file) {
  return (
    /^src\/renderer\/(components|routes|layouts)\/.+\.(tsx?|css)$/.test(file) ||
    /^src\/shared\/locales\/[^/]+\.json$/.test(file)
  )
}

function isCompanionUnitTest(file) {
  return (
    /^src\/(core|shared|main|server)\/.+\.test\.tsx?$/.test(file) &&
    !/(\.integration\.|\.win32\.|\.darwin\.|\/finalize\/|\/session\/|task-recovery-service)/.test(
      file
    )
  )
}

export function createCiPlan(eventName, files) {
  const ui =
    eventName === 'pull_request' &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.some(isPresentationPath) &&
    files.every((file) => isPresentationPath(file) || isCompanionUnitTest(file))
  const full = !ui
  const filesystems =
    !Array.isArray(files) ||
    files.length === 0 ||
    ['schedule', 'workflow_dispatch', 'merge_group'].includes(eventName) ||
    files.some(
      (file) =>
        !isCompanionUnitTest(file) &&
        /^(packages\/finalize-fs\/|src\/core\/|src\/shared\/(?!locales\/)|\.github\/|\.cargo\/|scripts\/|tests\/|package\.json$|pnpm-(lock\.yaml|workspace\.yaml)$|vitest.*\.ts$)/.test(
          file
        )
    )
  return {
    profile: ui ? 'ui' : 'full',
    distributions: full,
    installers: full,
    filesystems,
    package_matrix: {
      include: PACKAGE_TARGETS.filter(
        (target) => full || UI_TARGETS.has(target.target)
      ),
    },
  }
}

export function changedFiles(eventName, event, cwd = process.cwd()) {
  const base =
    eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before
  const head =
    eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
    throw new Error('Missing comparison revisions')
  }
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 ** 2,
    })
  const start =
    eventName === 'pull_request' ? git(['merge-base', base, head]).trim() : base
  // Disable rename detection so moving a core file into a UI directory still
  // includes the deleted core path. NUL delimiters preserve unusual filenames.
  return git(['diff', '--name-only', '--no-renames', '-z', start, head, '--'])
    .split('\0')
    .filter(Boolean)
}

function main() {
  let files
  try {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
    )
    files = changedFiles(process.env.GITHUB_EVENT_NAME, event)
  } catch {
    console.log('Comparison unavailable; selecting complete validation.')
  }
  const plan = createCiPlan(process.env.GITHUB_EVENT_NAME, files)
  for (const [key, value] of Object.entries(plan)) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`
    )
  }
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `CI profile: **${plan.profile}**\n\n` +
      `Desktop targets: ${plan.package_matrix.include.map((t) => t.target).join(', ')}\n\n` +
      `Snap/Flatpak: ${plan.distributions}; filesystem suites: ${plan.filesystems}.\n` +
      'All profiles run the complete root test suite and three torrent browsers.\n'
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
