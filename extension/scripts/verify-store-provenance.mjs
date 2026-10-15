import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyRelease } from './store-release.mjs'

const repository = 'motrixapp/motrix-extension'
const workflow = `${repository}/.github/workflows/release.yml`

// Arguments never pass through a shell. A failed gh verification is fatal;
// checksums alone are not an acceptable fallback for old releases.
export function verifyStoreProvenance(
  { directory, tag, expectedSha },
  run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim()
) {
  const files = verifyRelease(directory, tag)
  const ref = `refs/tags/${tag}`
  if (expectedSha !== undefined && !/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw new Error('Expected a complete release commit SHA')
  }
  // This also detects a tag changed while a submission awaited approval.
  run('git', [
    'fetch',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    `${ref}:${ref}`,
  ])
  const sha = run('git', ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!/^[a-f0-9]{40}$/.test(sha) || (expectedSha && sha !== expectedSha)) {
    throw new Error('Release tag no longer matches the verified commit')
  }
  run('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'])
  for (const name of [
    files.chromium,
    files.firefox,
    files.source,
    'SHA256SUMS.txt',
  ]) {
    run('gh', [
      'attestation',
      'verify',
      resolve(directory, name),
      '--repo',
      repository,
      '--signer-workflow',
      workflow,
      '--source-ref',
      ref,
      '--source-digest',
      sha,
      '--signer-digest',
      sha,
      '--deny-self-hosted-runners',
    ])
  }
  return sha
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== 'refs/heads/main'
    ) {
      throw new Error('Store submission must run on the upstream main branch')
    }
    const sha = verifyStoreProvenance({
      directory: 'artifacts',
      tag: process.env.RELEASE_TAG,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    })
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `release_sha=${sha}\n`)
    console.log(`Verified release provenance for ${sha}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
