const { join } = require('node:path')
const { VersionActions } = require('nx/src/command-line/release/version/version-actions')
const { rewritingMarkedVersions } = require('./release-versions.js')
const { rewritePathPinnedVersions } = require('./cargo-lockfiles.js')
const { tableKeyPattern } = require('./toml-table.js')

class TomlVersionActions extends VersionActions {
  get validManifestFilenames() {
    const manifest = this.finalConfigForProject.versionActionsOptions?.manifest
    return typeof manifest === 'string' ? [manifest] : null
  }

  settings() {
    const options = this.finalConfigForProject.versionActionsOptions ?? {}
    const { manifest, table, lockfile } = options
    if (typeof manifest !== 'string' || typeof table !== 'string') {
      throw new Error(`${this.projectGraphNode.name} sets no versionActionsOptions manifest and table`)
    }
    const root = this.projectGraphNode.data.root
    return {
      manifestPath: join(root, manifest),
      table,
      lockfilePath: typeof lockfile === 'string' ? join(root, lockfile) : null,
    }
  }

  async readCurrentVersionFromSourceManifest(tree) {
    const { manifestPath, table } = this.settings()
    const match = tableKeyPattern(table, 'version').exec(tree.read(manifestPath, 'utf-8') ?? '')
    if (match === null) throw new Error(`${manifestPath} holds no [${table}] version`)
    return { currentVersion: match[2], manifestPath }
  }

  async readCurrentVersionFromRegistry() {
    return null
  }

  async readCurrentVersionOfDependency() {
    return { currentVersion: null, dependencyCollection: null }
  }

  async updateProjectVersion(tree, newVersion) {
    const { manifestPath, table, lockfilePath } = this.settings()
    const manifest = tree.read(manifestPath, 'utf-8') ?? ''
    const versionKey = tableKeyPattern(table, 'version')
    if (!versionKey.test(manifest)) throw new Error(`${manifestPath} holds no [${table}] version`)
    tree.write(manifestPath, manifest.replace(versionKey, `$1${newVersion}$3`))
    const logMessages = [`✍️  New version ${newVersion} written to manifest: ${manifestPath}`]
    if (lockfilePath === null) return logMessages

    const nameMatch = tableKeyPattern(table, 'name').exec(manifest)
    if (nameMatch === null) throw new Error(`${manifestPath} holds no [${table}] name`)
    return [...logMessages, ...rewritePathPinnedVersions(tree, nameMatch[2], newVersion, lockfilePath)]
  }

  async updateProjectDependencies() {
    return []
  }
}

module.exports = {
  default: rewritingMarkedVersions(TomlVersionActions),
  afterAllProjectsVersioned: async () => ({ changedFiles: [], deletedFiles: [] }),
}
