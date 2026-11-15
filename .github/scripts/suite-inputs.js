const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { matchesAnyPath } = require('./changed-areas.js')
const { lockfileClosure } = require('./pnpm-lockfile.js')

const INPUT_HASH_FORMAT = 2
const LOCKFILE = 'pnpm-lock.yaml'
const COMMIT = /^[0-9a-f]{40}$/
const RELEASE_GENERATED = /(^|\/)CHANGELOG\.md$/
const GIT_OUTPUT_LIMIT_BYTES = 512 * 1024 * 1024

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_OUTPUT_LIMIT_BYTES })

function requireCommit(commit) {
  if (!COMMIT.test(commit)) throw new Error(`${JSON.stringify(commit)} is no full commit SHA`)
}

function isAncestor(ancestor, descendant) {
  requireCommit(ancestor)
  requireCommit(descendant)
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function resolvedHead() {
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  requireCommit(head)
  return head
}

function createInputHasher() {
  const trees = new Map()
  const blobs = new Map()
  const closures = new Map()

  function treeAt(commit) {
    requireCommit(commit)
    let entries = trees.get(commit)
    if (entries === undefined) {
      entries = git(['ls-tree', '-r', '-z', '--full-tree', commit])
        .split('\0')
        .filter(record => record.length > 0)
        .map(record => {
          const tab = record.indexOf('\t')
          const [mode, type, object] = record.slice(0, tab).split(' ')
          return { mode, type, object, path: record.slice(tab + 1) }
        })
      trees.set(commit, entries)
    }
    return entries
  }

  function blob(object) {
    let text = blobs.get(object)
    if (text === undefined) {
      text = git(['cat-file', 'blob', object])
      blobs.set(object, text)
    }
    return text
  }

  function versionlessManifest(entry) {
    const manifest = JSON.parse(blob(entry.object))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`${entry.path} holds no JSON object`)
    }
    const fields = Object.entries(manifest).filter(([key]) => key !== 'version')
    return `versionless ${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
  }

  function closureOf(lockfileObject, suite) {
    const key = `${lockfileObject}\0${suite.production === true}\0${suite.importers.join('\0')}`
    let closure = closures.get(key)
    if (closure === undefined) {
      closure = lockfileClosure(blob(lockfileObject), suite.importers, { production: suite.production === true })
      closures.set(key, closure)
    }
    return closure
  }

  return function inputHash(suiteName, suite, commit) {
    const entries = treeAt(commit)
    const except = suite.except ?? []
    const versionless = suite.manifestsWithoutVersion ?? []
    const lockfile = entries.find(entry => entry.path === LOCKFILE)
    if (lockfile === undefined) throw new Error(`${commit} holds no ${LOCKFILE}`)
    const closure = closureOf(lockfile.object, suite)
    const files = entries
      .filter(entry => matchesAnyPath(entry.path, suite.paths) && !matchesAnyPath(entry.path, except))
      .filter(entry => !RELEASE_GENERATED.test(entry.path))
      .map(entry => {
        const content = versionless.includes(entry.path) ? versionlessManifest(entry) : entry.object
        return `${entry.mode} ${entry.type} ${content}\t${entry.path}`
      })
    if (files.length === 0) throw new Error(`${commit} holds no input of the ${suiteName} suite`)
    const digest = createHash('sha256')
    digest.update(JSON.stringify({ format: INPUT_HASH_FORMAT, suite: suiteName, files }))
    digest.update(`\0${closure.digest}`)
    return digest.digest('hex')
  }
}

module.exports = { createInputHasher, isAncestor, requireCommit, resolvedHead }
