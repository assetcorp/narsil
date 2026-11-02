const { withAndroidManifest } = require('expo/config-plugins')

function withHarnessTraffic(config) {
  return withAndroidManifest(config, modified => {
    const application = modified.modResults.manifest.application?.[0]
    if (application !== undefined) application.$['android:usesCleartextTraffic'] = 'true'
    return modified
  })
}

module.exports = withHarnessTraffic
