const { execFileSync } = require('node:child_process')
const { posix } = require('node:path')
const { escapedForPattern } = require('./toml-table.js')

const PATH_KEY = /\bpath\s*=\s*"([^"]+)"/
const VERSION_KEY = /(\bversion\s*=\s*")([^"]*)(")/

function trackedManifests(repositoryRoot) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/Cargo.toml'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  return [...new Set(listed.split('\0').filter(path => path.length > 0))]
}

function inlineDependencyPattern(packageName) {
  return new RegExp(`^(${escapedForPattern(packageName)}\\s*=\\s*\\{)([^}\\r\\n]*)(\\})`, 'gm')
}

function pathRequirementChanges(tree, packageName, packageRoot, newVersion) {
  const root = posix.normalize(packageRoot.replace(/\\/g, '/'))
  const changes = []
  for (const path of trackedManifests(tree.root)) {
    const text = tree.read(path, 'utf-8')
    if (text === null) throw new Error(`${path} is tracked by git but cannot be read`)
    let rewrote = false
    const rewritten = text.replace(inlineDependencyPattern(packageName), (whole, open, body, close) => {
      const target = PATH_KEY.exec(body)
      if (target === null || posix.join(posix.dirname(path), target[1]) !== root) return whole
      if (!VERSION_KEY.test(body)) return whole
      rewrote = true
      return `${open}${body.replace(VERSION_KEY, `$1${newVersion}$3`)}${close}`
    })
    if (rewrote) changes.push({ path, text: rewritten })
  }
  return changes
}

module.exports = { pathRequirementChanges }
