import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  APPIMAGE_TOOLSET_VERSION,
  appImageArchFromBuilder,
  assertAppImageRuntimeMetadata,
  ELECTRON_BUILDER_VERSION,
  expectedAppImageName,
  expectedZsyncName,
  inspectAppImageRuntime,
  inspectEmbeddedBlockmap,
  nativeUpdateInformation,
  stripEmbeddedBlockmap,
  verifyZsyncFile,
  writeAppImageUpdateInformation,
} from './appimage-artifact.mjs'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

function defaultAppendBlockmap(file) {
  const {
    appendBlockmap,
  } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js')
  return appendBlockmap(file)
}

function installedElectronBuilderVersion() {
  return require('electron-builder/package.json').version
}

export async function generateZsync(appImagePath, zsyncPath) {
  const temporary = `${zsyncPath}.tmp-${process.pid}`
  await rm(temporary, { force: true })
  try {
    const name = path.basename(appImagePath)
    await execFileAsync(
      'zsyncmake',
      ['-e', '-f', name, '-u', name, '-o', temporary, appImagePath],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    await rename(temporary, zsyncPath)
  } catch (error) {
    throw new Error(
      `Failed to generate ${path.basename(zsyncPath)} with zsyncmake: ${error.message}`,
      { cause: error }
    )
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function finalizeAppImageArtifact(event, dependencies = {}) {
  if (event?.target?.name !== 'appImage') return
  if (typeof event.file !== 'string' || !event.file.endsWith('.AppImage')) {
    throw new Error('AppImage artifact hook received an unexpected file')
  }

  const version = event.packager?.appInfo?.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('AppImage artifact hook could not determine the version')
  }
  const arch = appImageArchFromBuilder(event.arch)
  const expectedName = expectedAppImageName(version, arch)
  if (path.basename(event.file) !== expectedName) {
    throw new Error(
      `Unexpected AppImage artifact ${path.basename(event.file)}; expected ${expectedName}`
    )
  }
  const configuredToolset = event.packager?.config?.toolsets?.appimage
  if (configuredToolset !== APPIMAGE_TOOLSET_VERSION) {
    throw new Error(
      `AppImage toolset must be ${APPIMAGE_TOOLSET_VERSION}, got ${configuredToolset ?? '<unset>'}`
    )
  }

  const getBuilderVersion =
    dependencies.getBuilderVersion ?? installedElectronBuilderVersion
  const builderVersion = getBuilderVersion()
  if (builderVersion !== ELECTRON_BUILDER_VERSION) {
    throw new Error(
      `AppImage finalization requires electron-builder ${ELECTRON_BUILDER_VERSION}, got ${builderVersion}`
    )
  }
  if (
    !event.updateInfo ||
    !Number.isSafeInteger(event.updateInfo.blockMapSize) ||
    event.updateInfo.blockMapSize <= 0
  ) {
    throw new Error('electron-builder did not provide an embedded blockmap')
  }

  const inspectRuntime = dependencies.inspectRuntime ?? inspectAppImageRuntime
  const assertMetadata =
    dependencies.assertMetadata ?? assertAppImageRuntimeMetadata
  const stripBlockmap = dependencies.stripBlockmap ?? stripEmbeddedBlockmap
  const writeUpdateInformation =
    dependencies.writeUpdateInformation ?? writeAppImageUpdateInformation
  const appendBlockmap = dependencies.appendBlockmap ?? defaultAppendBlockmap
  const inspectBlockmap =
    dependencies.inspectBlockmap ?? inspectEmbeddedBlockmap
  const createZsync = dependencies.generateZsync ?? generateZsync
  const checkZsync = dependencies.verifyZsync ?? verifyZsyncFile

  const initialRuntime = await inspectRuntime(event.file, arch)
  assertMetadata(initialRuntime, {
    updateInformation: '',
    requireUnsigned: true,
  })
  await stripBlockmap(event.file, event.updateInfo.blockMapSize)

  const updateInformation = nativeUpdateInformation(version, arch)
  await writeUpdateInformation(event.file, arch, updateInformation)

  // electron-updater hashes and downloads the complete AppImage including its
  // embedded blockmap. Rebuild it after mutating .upd_info, then replace the
  // event metadata before PublishManager creates latest/beta-linux*.yml.
  event.updateInfo = await appendBlockmap(event.file)
  const rebuilt = await inspectBlockmap(event.file)
  if (rebuilt.blockMapSize !== event.updateInfo.blockMapSize) {
    throw new Error('Rebuilt AppImage blockmap metadata does not match footer')
  }

  const finalRuntime = await inspectRuntime(event.file, arch)
  assertMetadata(finalRuntime, {
    updateInformation,
    requireUnsigned: true,
  })

  const zsyncPath = path.join(
    path.dirname(event.file),
    expectedZsyncName(version, arch)
  )
  await createZsync(event.file, zsyncPath)
  await checkZsync({ appImagePath: event.file, zsyncPath })
}

export default finalizeAppImageArtifact
