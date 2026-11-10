const { join } = require('node:path')
const { VersionActions } = require('nx/src/command-line/release/version/version-actions')

const CRATE_MANIFEST = 'Cargo.toml'
const CRATE_LOCKFILE = 'Cargo.lock'
const PACKAGE_TABLE_VERSION = /(^\[package\]\s*$(?:(?!^\[)[\s\S])*?^version\s*=\s*")([^"]+)(")/m
const PACKAGE_TABLE_NAME = /^\[package\]\s*$(?:(?!^\[)[\s\S])*?^name\s*=\s*"([^"]+)"/m

function lockedPackageVersion(crateName) {
  const escaped = crateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^\\[\\[package\\]\\]\\s*^name\\s*=\\s*"${escaped}"\\s*^version\\s*=\\s*")([^"]+)(")`, 'm')
}

function crateNameOf(manifest) {
  const match = PACKAGE_TABLE_NAME.exec(manifest)
  if (match === null) throw new Error('Cargo.toml holds no [package] name')
  return match[1]
}

class CargoVersionActions extends VersionActions {
  validManifestFilenames = [CRATE_MANIFEST]

  manifestPathOf() {
    return join(this.projectGraphNode.data.root, CRATE_MANIFEST)
  }

  async readCurrentVersionFromSourceManifest(tree) {
    const manifestPath = this.manifestPathOf()
    const match = PACKAGE_TABLE_VERSION.exec(tree.read(manifestPath, 'utf-8') ?? '')
    if (match === null) throw new Error(`${manifestPath} holds no [package] version`)
    return { currentVersion: match[2], manifestPath }
  }

  async readCurrentVersionFromRegistry() {
    return null
  }

  async readCurrentVersionOfDependency() {
    return { currentVersion: null, dependencyCollection: null }
  }

  async updateProjectVersion(tree, newVersion) {
    const manifestPath = this.manifestPathOf()
    const manifest = tree.read(manifestPath, 'utf-8') ?? ''
    if (!PACKAGE_TABLE_VERSION.test(manifest)) throw new Error(`${manifestPath} holds no [package] version`)
    tree.write(manifestPath, manifest.replace(PACKAGE_TABLE_VERSION, `$1${newVersion}$3`))
    const logMessages = [`✍️  New version ${newVersion} written to manifest: ${manifestPath}`]

    const lockfilePath = join(this.projectGraphNode.data.root, CRATE_LOCKFILE)
    const lockfile = tree.read(lockfilePath, 'utf-8')
    if (lockfile === null) return logMessages
    const lockedVersion = lockedPackageVersion(crateNameOf(manifest))
    if (!lockedVersion.test(lockfile)) throw new Error(`${lockfilePath} holds no entry for the crate`)
    tree.write(lockfilePath, lockfile.replace(lockedVersion, `$1${newVersion}$3`))
    logMessages.push(`✍️  New version ${newVersion} written to lockfile: ${lockfilePath}`)
    return logMessages
  }

  async updateProjectDependencies() {
    return []
  }
}

module.exports = {
  default: CargoVersionActions,
  afterAllProjectsVersioned: async () => ({ changedFiles: [], deletedFiles: [] }),
}
