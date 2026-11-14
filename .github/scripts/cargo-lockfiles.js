const { execFileSync } = require('node:child_process')
const { escapedForPattern } = require('./toml-table.js')

const PACKAGE_HEADER = '[[package]]'
const ENTRY_KEY = /^(name|version|source) = "([^"]*)"$/

function trackedLockfiles(repositoryRoot) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/Cargo.lock'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  return listed.split('\0').filter(path => path.length > 0)
}

function entriesWithoutSource(lines, packageName) {
  const entries = []
  let entry = null
  lines.forEach((line, index) => {
    if (line.startsWith('[')) {
      entry = line === PACKAGE_HEADER ? { name: null, version: null, versionLine: null, sourced: false } : null
      if (entry !== null) entries.push(entry)
      return
    }
    if (entry === null) return
    const key = ENTRY_KEY.exec(line)
    if (key === null) return
    if (key[1] === 'name') entry.name = key[2]
    else if (key[1] === 'version') {
      entry.version = key[2]
      entry.versionLine = index
    } else entry.sourced = true
  })
  return entries.filter(
    candidate => candidate.name === packageName && !candidate.sourced && candidate.versionLine !== null,
  )
}

function rewrittenLockfile(text, packageName, newVersion) {
  const lines = text.split('\n')
  const entries = entriesWithoutSource(lines, packageName)
  if (entries.length === 0) return null
  const name = escapedForPattern(packageName)
  for (const entry of entries) {
    lines[entry.versionLine] = `version = "${newVersion}"`
    const reference = new RegExp(`^(\\s*"${name} )${escapedForPattern(entry.version)}(",?)$`)
    lines.forEach((line, index) => {
      lines[index] = line.replace(reference, `$1${newVersion}$2`)
    })
  }
  return lines.join('\n')
}

function rewritePathPinnedVersions(tree, packageName, newVersion, requiredLockfile) {
  const messages = []
  let requiredLockfileRewritten = false
  for (const path of trackedLockfiles(tree.root)) {
    const text = tree.read(path, 'utf-8')
    if (text === null) continue
    const rewritten = rewrittenLockfile(text, packageName, newVersion)
    if (rewritten === null) continue
    if (path === requiredLockfile) requiredLockfileRewritten = true
    tree.write(path, rewritten)
    messages.push(`✍️  New version ${newVersion} written to lockfile: ${path}`)
  }
  if (!requiredLockfileRewritten) {
    throw new Error(`${requiredLockfile} holds no entry for ${packageName} that Cargo resolves by path`)
  }
  return messages
}

module.exports = { rewritePathPinnedVersions }
