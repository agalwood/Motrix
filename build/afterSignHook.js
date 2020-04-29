require('dotenv').config()
const { notarize } = require('electron-notarize')
const pkg = require('../package.json')

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') {
    return
  }

  const skipNotarize = process.env.SKIP_NOTARIZE
  if (skipNotarize === 'yes') {
    console.log('skipping notarize')
    return
  }

  const appBundleId = pkg.build.appId
  const appName = context.packager.appInfo.productFilename

  return await notarize({
    appBundleId,
    appPath: `${appOutDir}/${appName}.app`,
    ascProvider: process.env.TEAM_ID,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PWD
  })
}
