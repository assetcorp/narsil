const { join } = require('node:path')
const jsVersionActions = require('@nx/js/src/release/version-actions')

const PLATFORM_PACKAGES_DIRECTORY = join('packages', 'native', 'npm')

class NativePlatformVersionActions extends jsVersionActions.default {
  async updateProjectVersion(tree, newVersion) {
    const logMessages = await super.updateProjectVersion(tree, newVersion)
    for (const platform of tree.children(PLATFORM_PACKAGES_DIRECTORY)) {
      const manifestPath = join(PLATFORM_PACKAGES_DIRECTORY, platform, 'package.json')
      if (!tree.exists(manifestPath)) continue
      const manifest = JSON.parse(tree.read(manifestPath, 'utf-8'))
      manifest.version = newVersion
      tree.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      logMessages.push(`✍️  New version ${newVersion} written to manifest: ${manifestPath}`)
    }
    return logMessages
  }
}

module.exports = {
  default: NativePlatformVersionActions,
  afterAllProjectsVersioned: jsVersionActions.afterAllProjectsVersioned,
}
