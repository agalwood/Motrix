import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  parseDryRun,
  releaseFiles,
  STORE_IDS,
  verifyRelease,
} from './store-release.mjs'

export function submissionConfig({ store, tag, directory, dryRun }, env) {
  if (!STORE_IDS.includes(store)) throw new Error('Select one supported store')
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean')
  const files = releaseFiles(tag)
  const required = (name) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing required setting: ${name}`)
    return value
  }
  if (store === 'chrome') {
    return {
      dryRun,
      chrome: {
        apiVersion: 'v2',
        extensionId: CHROME_EXTENSION_ID,
        publisherId: required('CHROME_PUBLISHER_ID'),
        serviceAccountClientEmail: required(
          'CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL'
        ),
        serviceAccountPrivateKey: required(
          'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY'
        ).replace(/\\n/g, '\n'),
        zip: resolve(directory, files.chromium),
        skipSubmitReview: false,
        skipReview: false,
        cancelPending: false,
        publishType: 'DEFAULT_PUBLISH',
      },
    }
  }
  if (store === 'edge') {
    const productId = required('EDGE_PRODUCT_ID')
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(productId)) {
      throw new Error(
        'EDGE_PRODUCT_ID must be the Partner Center GUID, not the public extension ID'
      )
    }
    return {
      dryRun,
      edge: {
        productId,
        clientId: required('EDGE_CLIENT_ID'),
        apiKey: required('EDGE_API_KEY'),
        zip: resolve(directory, files.chromium),
        skipSubmitReview: false,
      },
    }
  }
  return {
    dryRun,
    firefox: {
      extensionId: FIREFOX_EXTENSION_ID,
      jwtIssuer: required('FIREFOX_JWT_ISSUER'),
      jwtSecret: required('FIREFOX_JWT_SECRET'),
      zip: resolve(directory, files.firefox),
      sourcesZip: resolve(directory, files.source),
      channel: 'listed',
      // Desktop and Android compatibility come from browser_specific_settings.
      // AMO rejects a post-upload override when gecko_android is in the manifest.
      skipSubmitReview: false,
    },
  }
}

export async function submitStore(
  options,
  { env = process.env, publish } = {}
) {
  verifyRelease(options.directory, options.tag)
  const config = submissionConfig(options, env)
  const submit = publish ?? publishStoreConfig
  const results = await submit(config)
  if (results[options.store]?.success !== true) {
    throw new Error(
      `${options.store} submission failed; inspect the publisher output before retrying`
    )
  }
}

async function publishStoreConfig(config) {
  const {
    ChromeWebStoreV2,
    EdgeAddonStoreV1_1,
    FirefoxAddonStoreV5,
    validateConfig,
  } = await import('publish-browser-extension')
  // The upstream multi-store submit() calls process.exit on failure. Use its
  // public store adapters so errors reach our job summary. Validate the explicit
  // config directly to prevent ambient *_ZIP variables from selecting stores.
  const resolved = validateConfig(config)
  const store = STORE_IDS.find((name) => resolved[name])
  const adapters = {
    chrome: ChromeWebStoreV2,
    edge: EdgeAddonStoreV1_1,
    firefox: FirefoxAddonStoreV5,
  }
  const adapter = new adapters[store](resolved[store], (status) =>
    console.log(status)
  )
  await adapter.ensureZipsExist()
  await adapter.submit(resolved.dryRun)
  return { [store]: { success: true } }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let result = 'Failed; inspect the job log and store status before retrying.'
  const store = process.env.STORE
  const tag = process.env.RELEASE_TAG
  try {
    const dryRun = parseDryRun(process.env.DRY_RUN)
    await submitStore({ store, tag, directory: 'artifacts', dryRun })
    result = dryRun
      ? store === 'edge'
        ? 'Dry run passed local checks. Upstream does not validate Edge API credentials in dry-run mode.'
        : 'Dry run passed artifact and authentication checks; nothing uploaded.'
      : 'Submitted for review. Store approval and public availability are separate.'
    console.log(result)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    if (
      process.env.GITHUB_STEP_SUMMARY &&
      STORE_IDS.includes(store) &&
      /^v\d+\.\d+\.\d+$/.test(tag)
    ) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### ${store}: ${tag}\n\n${result}\n`
      )
    }
  }
}
