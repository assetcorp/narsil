const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { posix } = require('node:path')
const { versionPathPackage } = require('./cargo-lockfile-references.js')

const requireFromNx = createRequire(require.resolve('nx/package.json'))
const { parse, stringify } = requireFromNx('smol-toml')
const { valid } = requireFromNx('semver')

function trackedLockfiles(repositoryRoot) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/Cargo.lock'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  return [...new Set(listed.split('\0').filter(path => path.length > 0))]
}

function parsedLockfile(path, text) {
  const document = parse(text)
  if (![3, 4].includes(document.version) || !Array.isArray(document.package)) {
    throw new Error(`${path} must hold a Cargo lockfile with format version 3 or 4 and a package array`)
  }
  const identities = new Set()
  const pathNames = new Set()
  for (const entry of document.package) {
    if (
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.version !== 'string' ||
      valid(entry.version) === null ||
      !/^\d/.test(entry.version) ||
      entry.version.trim() !== entry.version ||
      (entry.source !== undefined && (typeof entry.source !== 'string' || entry.source.length === 0)) ||
      (entry.dependencies !== undefined &&
        (!Array.isArray(entry.dependencies) || entry.dependencies.some(value => typeof value !== 'string'))) ||
      (entry.replace !== undefined && typeof entry.replace !== 'string')
    ) {
      throw new Error(`${path} holds an invalid Cargo package entry`)
    }
    const identity = JSON.stringify([entry.name, entry.version, entry.source])
    if (identities.has(identity) || (entry.source === undefined && pathNames.has(entry.name))) {
      throw new Error(`${path} holds duplicate Cargo package entries for ${entry.name}`)
    }
    identities.add(identity)
    if (entry.source === undefined) pathNames.add(entry.name)
  }
  return document
}

function lockfileText(document, original) {
  const prefix = original.match(/^(?:[ \t]*#[^\r\n]*(?:\r?\n|$))*/)[0].replace(/\r\n/g, '\n')
  const text = stringify(document).replace(/^dependencies = (\[.*\])$/gm, (line, array) => {
    const values = parse(`dependencies = ${array}`).dependencies
    if (values.length === 0 || values.some(value => typeof value !== 'string')) return line
    return `dependencies = [\n${values.map(value => ` ${JSON.stringify(value)},`).join('\n')}\n]`
  })
  const rewritten = prefix + text
  return original.includes('\r\n') ? rewritten.replace(/\n/g, '\r\n') : rewritten
}

function rewrittenLockfile(path, text, packageName, newVersion) {
  let document
  try {
    document = parsedLockfile(path, text)
  } catch (error) {
    throw new Error(`Cannot version ${path}: ${error.message}`, { cause: error })
  }
  const entry = document.package.find(candidate => candidate.name === packageName && candidate.source === undefined)
  if (entry === undefined) return null
  versionPathPackage(document.package, entry, newVersion)
  return lockfileText(document, text)
}

function pathPinnedVersionChanges(tree, packageName, newVersion, requiredLockfile) {
  const changes = []
  const requiredPath = posix.normalize(requiredLockfile.replace(/\\/g, '/'))
  for (const path of trackedLockfiles(tree.root)) {
    const text = tree.read(path, 'utf-8')
    if (text === null) throw new Error(`${path} is tracked by git but cannot be read`)
    const rewritten = rewrittenLockfile(path, text, packageName, newVersion)
    if (rewritten !== null) changes.push({ path, text: rewritten })
  }
  if (!changes.some(change => change.path === requiredPath)) {
    throw new Error(`${requiredLockfile} holds no tracked entry for ${packageName} that Cargo resolves by path`)
  }
  return changes
}

module.exports = { pathPinnedVersionChanges }
