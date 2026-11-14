const { createHash } = require('node:crypto')

const SECTION_HEADER = /^([A-Za-z][\w-]*):(.*)$/
const SECTIONS_WITH_ENTRIES = new Set(['importers', 'packages', 'snapshots'])
const IMPORTER_DEPENDENCY_KINDS = ['dependencies', 'optionalDependencies', 'devDependencies']
const SNAPSHOT_DEPENDENCY_KINDS = new Set(['dependencies', 'optionalDependencies'])
const WORKSPACE_LINK = /^(link|file|workspace):/

function unquoted(text) {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return JSON.parse(text)
  return text
}

function keyAndValue(text) {
  if (text.startsWith("'")) {
    const closing = /^'((?:[^']|'')*)':(?: (.*))?$/.exec(text)
    if (closing === null) throw new Error(`pnpm-lock.yaml holds a key that this parser cannot read: ${text}`)
    return { key: closing[1].replaceAll("''", "'"), value: closing[2] ?? '' }
  }
  if (text.startsWith('"')) {
    const closing = /^("(?:[^"\\]|\\.)*"):(?: (.*))?$/.exec(text)
    if (closing === null) throw new Error(`pnpm-lock.yaml holds a key that this parser cannot read: ${text}`)
    return { key: JSON.parse(closing[1]), value: closing[2] ?? '' }
  }
  if (text.endsWith(':')) return { key: text.slice(0, -1), value: '' }
  const separator = text.indexOf(': ')
  if (separator === -1) throw new Error(`pnpm-lock.yaml holds a line that this parser cannot read: ${text}`)
  return { key: text.slice(0, separator), value: text.slice(separator + 2) }
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

function parsedLockfile(text) {
  if (text.includes('\r')) throw new Error('pnpm-lock.yaml holds carriage returns, which this parser refuses')
  const header = []
  const entries = { importers: new Map(), packages: new Map(), snapshots: new Map() }
  let section = null
  let entry = null
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const top = SECTION_HEADER.exec(line)
    if (top !== null) {
      section = top[1]
      entry = null
      if (!SECTIONS_WITH_ENTRIES.has(section)) header.push(line)
      continue
    }
    if (section === null) throw new Error(`pnpm-lock.yaml starts with a line outside any section: ${line}`)
    if (!SECTIONS_WITH_ENTRIES.has(section)) {
      header.push(line)
      continue
    }
    if (indentOf(line) === 2) {
      const { key, value } = keyAndValue(line.slice(2))
      if (entries[section].has(key)) throw new Error(`pnpm-lock.yaml lists ${section} entry ${key} twice`)
      entry = { lines: [line], flowValue: value }
      entries[section].set(key, entry)
      continue
    }
    if (entry === null || indentOf(line) < 4) {
      throw new Error(`pnpm-lock.yaml holds a line outside any ${section} entry: ${line}`)
    }
    entry.lines.push(line)
  }
  for (const name of SECTIONS_WITH_ENTRIES) {
    if (entries[name].size === 0 && name !== 'snapshots') throw new Error(`pnpm-lock.yaml holds no ${name}`)
  }
  return { header: header.join('\n'), ...entries }
}

function nestedPairs(entry, kinds, kindIndent) {
  const pairs = []
  let kind = null
  for (const line of entry.lines.slice(1)) {
    const indent = indentOf(line)
    if (indent === kindIndent) {
      const { key, value } = keyAndValue(line.trimStart())
      kind = kinds.has(key) && value === '' ? key : null
      continue
    }
    if (kind === null || indent !== kindIndent + 2) continue
    const { key, value } = keyAndValue(line.trimStart())
    pairs.push({ kind, name: unquoted(key), value: unquoted(value) })
  }
  return pairs
}

function importerDependencies(entry, kinds) {
  const dependencies = []
  let current = null
  let kind = null
  for (const line of entry.lines.slice(1)) {
    const indent = indentOf(line)
    const { key, value } = keyAndValue(line.trimStart())
    if (indent === 4) {
      kind = IMPORTER_DEPENDENCY_KINDS.includes(key) && value === '' ? key : null
      current = null
      continue
    }
    if (kind === null) continue
    if (indent === 6) {
      current = { kind, name: unquoted(key), specifier: null, version: null }
      dependencies.push(current)
      continue
    }
    if (indent === 8 && current !== null && (key === 'specifier' || key === 'version')) current[key] = unquoted(value)
  }
  return dependencies.filter(dependency => kinds.includes(dependency.kind))
}

function snapshotKey(name, version) {
  const beforePeers = version.split('(')[0]
  return beforePeers.includes('@') ? version : `${name}@${version}`
}

function packageKey(key) {
  const peers = key.indexOf('(', 1)
  return peers === -1 ? key : key.slice(0, peers)
}

function lockfileClosure(text, importerPaths, { production }) {
  const lockfile = parsedLockfile(text)
  const kinds = production ? ['dependencies', 'optionalDependencies'] : IMPORTER_DEPENDENCY_KINDS
  const importers = []
  const pending = []
  for (const path of importerPaths) {
    const importer = lockfile.importers.get(path)
    if (importer === undefined) throw new Error(`pnpm-lock.yaml lists no importer ${path}`)
    const dependencies = importerDependencies(importer, kinds)
    for (const dependency of dependencies) {
      if (dependency.version === null)
        throw new Error(`pnpm-lock.yaml resolves no version of ${dependency.name} in ${path}`)
      if (!WORKSPACE_LINK.test(dependency.version)) pending.push(snapshotKey(dependency.name, dependency.version))
    }
    importers.push({ path, dependencies })
  }

  const visited = new Set()
  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) continue
    visited.add(key)
    const snapshot = lockfile.snapshots.get(key)
    if (snapshot === undefined) throw new Error(`pnpm-lock.yaml lists no snapshot ${key}`)
    if (!lockfile.packages.has(packageKey(key))) throw new Error(`pnpm-lock.yaml lists no package ${packageKey(key)}`)
    for (const dependency of nestedPairs(snapshot, SNAPSHOT_DEPENDENCY_KINDS, 4)) {
      if (!WORKSPACE_LINK.test(dependency.value)) pending.push(snapshotKey(dependency.name, dependency.value))
    }
  }

  const digest = createHash('sha256')
  digest.update(JSON.stringify({ header: lockfile.header, importers }))
  const snapshots = [...visited].sort()
  for (const key of snapshots) {
    digest.update(`\0${lockfile.snapshots.get(key).lines.join('\n')}`)
    digest.update(`\0${lockfile.packages.get(packageKey(key)).lines.join('\n')}`)
  }
  return { digest: digest.digest('hex'), packages: [...new Set(snapshots.map(packageKey))].sort() }
}

module.exports = { lockfileClosure }
