const { execFileSync } = require('node:child_process')
const { tableKeyPattern } = require('./toml-table.js')

const RELEASED_PROJECTS = {
  'narsil-ts': { manifest: 'packages/ts/package.json' },
  'narsil-embeddings-transformers': { manifest: 'packages/embeddings-transformers/package.json' },
  'narsil-certutil': { manifest: 'packages/certutil/package.json' },
  'narsil-rust': { manifest: 'packages/rust/Cargo.toml', table: 'package' },
  'narsil-python': { manifest: 'packages/python/pyproject.toml', table: 'project' },
  'narsil-python-engine': { manifest: 'packages/python-engine/Cargo.toml', table: 'package' },
}

const MARKER_OPENING = /^\s*<!--\s*release-version\s+(\S+)\s*-->\s*$/
const MARKER_CLOSING = /^\s*<!--\s*\/release-version\s*-->\s*$/
const MARKER_ANY = /<!--\s*\/?release-version\b/
const INLINE_CODE = /(`+)[^`]*?\1/g
const VERSION = /(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![\w.]*\d)/g
const NARSIL_PACKAGE = new RegExp(
  [
    '@delali/narsil',
    '\\bdelali-narsil\\b',
    '\\bnarsil-client\\b',
    'github\\.com/assetcorp/narsil/packages/go',
    '\\bpackages/go(?:/engine|/changes)?/v\\d',
    '\\bNarsil\\s+v?\\d+\\.\\d+\\.\\d+',
  ].join('|'),
)
const FILES_OUTSIDE_THE_CHECK = [/(^|\/)CHANGELOG\.md$/, /^packages\/spec\//, /^BENCHMARKS\.md$/, /^benchmarks\//]

function markdownFilesInScope(repositoryRoot) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: repositoryRoot, encoding: 'utf8' })
  const files = listed.split('\0').filter(path => path.length > 0)
  if (files.length === 0) throw new Error(`git lists no Markdown file under ${repositoryRoot}`)
  return files.filter(path => !FILES_OUTSIDE_THE_CHECK.some(pattern => pattern.test(path)))
}

function versionsOn(line) {
  return [...line.matchAll(VERSION)].map(match => ({ text: match[1], index: match.index }))
}

function markedRegions(path, text) {
  const lines = text.split('\n')
  const regions = []
  let open = null
  lines.forEach((line, index) => {
    const opening = MARKER_OPENING.exec(line)
    if (opening !== null) {
      if (open !== null) throw new Error(`${path}:${index + 1} opens a release-version marker inside another one`)
      if (RELEASED_PROJECTS[opening[1]] === undefined) {
        const known = Object.keys(RELEASED_PROJECTS).join(', ')
        throw new Error(`${path}:${index + 1} marks ${opening[1]}, which is none of ${known}`)
      }
      open = { project: opening[1], start: index }
      return
    }
    if (MARKER_CLOSING.test(line)) {
      if (open === null) throw new Error(`${path}:${index + 1} closes a release-version marker that it never opened`)
      regions.push({ ...open, end: index })
      open = null
      return
    }
    if (MARKER_ANY.test(line.replace(INLINE_CODE, '')))
      throw new Error(`${path}:${index + 1} holds a release-version marker that is not alone on its line`)
  })
  if (open !== null) throw new Error(`${path}:${open.start + 1} opens a release-version marker that it never closes`)
  for (const region of regions) {
    const marked = lines.slice(region.start + 1, region.end).some(line => versionsOn(line).length > 0)
    if (!marked) throw new Error(`${path}:${region.start + 1} marks no version between its markers`)
  }
  return { lines, regions }
}

function manifestVersion(repositoryRoot, project, readText) {
  const { manifest, table } = RELEASED_PROJECTS[project]
  const text = readText(`${repositoryRoot}/${manifest}`)
  if (text === null) throw new Error(`${manifest} is missing`)
  if (table === undefined) {
    const version = JSON.parse(text).version
    if (typeof version !== 'string') throw new Error(`${manifest} holds no version`)
    return version
  }
  const match = tableKeyPattern(table, 'version').exec(text)
  if (match === null) throw new Error(`${manifest} holds no [${table}] version`)
  return match[2]
}

function problemsIn(path, text, versionOf) {
  const { lines, regions } = markedRegions(path, text)
  const problems = []
  const projectOfLine = new Map()
  for (const region of regions) {
    for (let index = region.start + 1; index < region.end; index += 1) projectOfLine.set(index, region.project)
  }
  lines.forEach((line, index) => {
    const project = projectOfLine.get(index)
    if (project === undefined) {
      if (NARSIL_PACKAGE.test(line) && versionsOn(line).length > 0) {
        problems.push(`${path}:${index + 1} names a Narsil version outside a release-version marker`)
      }
      return
    }
    const expected = versionOf(project)
    for (const found of versionsOn(line)) {
      if (found.text !== expected) {
        problems.push(`${path}:${index + 1} names ${found.text}, while ${project} is at ${expected}`)
      }
    }
  })
  return problems
}

function rewrittenText(path, text, project, version) {
  const { lines, regions } = markedRegions(path, text)
  let changed = false
  for (const region of regions.filter(candidate => candidate.project === project)) {
    for (let index = region.start + 1; index < region.end; index += 1) {
      const line = lines[index]
      const rewritten = line.replace(VERSION, (whole, number) => whole.replace(number, version))
      if (rewritten !== line) {
        lines[index] = rewritten
        changed = true
      }
    }
  }
  return changed ? lines.join('\n') : null
}

function rewriteMarkedVersions(tree, project, version) {
  if (RELEASED_PROJECTS[project] === undefined) throw new Error(`${project} has no entry in RELEASED_PROJECTS`)
  const messages = []
  for (const path of markdownFilesInScope(tree.root)) {
    const text = tree.read(path, 'utf-8')
    if (text === null) continue
    const rewritten = rewrittenText(path, text, project, version)
    if (rewritten === null) continue
    tree.write(path, rewritten)
    messages.push(`✍️  New version ${version} written to the marked lines of ${path}`)
  }
  return messages
}

function rewritingMarkedVersions(VersionActions) {
  return class extends VersionActions {
    async updateProjectVersion(tree, newVersion) {
      const messages = await super.updateProjectVersion(tree, newVersion)
      return [...messages, ...rewriteMarkedVersions(tree, this.projectGraphNode.name, newVersion)]
    }
  }
}

module.exports = {
  RELEASED_PROJECTS,
  manifestVersion,
  markdownFilesInScope,
  problemsIn,
  rewriteMarkedVersions,
  rewritingMarkedVersions,
}
