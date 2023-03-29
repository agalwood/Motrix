require('dotenv').config()
const { notarize } = require('electron-notarize')
const { appId } = require('../electron-builder.json')

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') {
    return
  }

  const skipNotarize = process.env.SKIP_NOTARIZE
  if (skipNotarize === 'true') {
    console.log('skipping notarize')
    return
  }

  const appBundleId = appId
  const appName = context.packager.appInfo.productFilename

  return await notarize({
    appBundleId,
    appPath: `${appOutDir}/${appName}.app`,
    ascProvider: process.env.TEAM_ID,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PWD
  })
}
