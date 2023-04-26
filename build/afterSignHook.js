require('dotenv').config()
const { join } = require('path')
const { notarize } = require('@electron/notarize')
const { appId } = require('../electron-builder.json')

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') {
    return
  }

  const skipNotarize = process.env.SKIP_NOTARIZE
  if (skipNotarize === 'true') {
    console.log('Skipping notarize')
    return
  }

  const appBundleId = appId
  const appName = context.packager.appInfo.productFilename
  const appPath = join(appOutDir, `${appName}.app`)

  try {
    await notarize({
      tool: 'notarytool',
      appBundleId,
      appPath,
      teamId: process.env.TEAM_ID,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD
    })
  } catch (error) {
    console.error(error)
  }

  console.log(`Done notarizing ${appId}`)
}
