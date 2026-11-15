function resolveReference(reference, packages) {
  const match = /^(\S+)(?: ([^\s()]+)(?: \((.+)\))?)?$/.exec(reference)
  if (match === null) throw new Error(`Invalid Cargo dependency reference: ${reference}`)
  const [, name, version, source] = match
  let candidates = packages.filter(entry => entry.name === name && (version === undefined || entry.version === version))
  if (version === undefined && new Set(candidates.map(entry => entry.version)).size !== 1) {
    throw new Error(`Ambiguous Cargo dependency reference: ${reference}`)
  }
  if (source !== undefined) {
    candidates = candidates.filter(entry => entry.source === source)
  } else {
    const paths = candidates.filter(entry => entry.source === undefined)
    if (paths.length > 0) candidates = paths
  }
  if (candidates.length !== 1) throw new Error(`Unresolved Cargo dependency reference: ${reference}`)
  return candidates[0]
}

function encodedReference(entry, packages) {
  const sameName = packages.filter(candidate => candidate.name === entry.name)
  if (sameName.length === 1) return entry.name
  const sameVersion = sameName.filter(candidate => candidate.version === entry.version)
  const source = sameVersion.length > 1 && entry.source !== undefined ? ` (${entry.source})` : ''
  return `${entry.name} ${entry.version}${source}`
}

function versionPathPackage(packages, pathEntry, newVersion) {
  const resolve = reference => {
    const name = reference.split(' ')[0]
    return name === pathEntry.name ? resolveReference(reference, packages) : reference
  }
  const references = packages.map(entry => ({
    entry,
    dependencies: entry.dependencies?.map(resolve),
    replacement: entry.replace === undefined ? undefined : resolve(entry.replace),
  }))
  pathEntry.version = newVersion
  const encode = reference => (typeof reference === 'string' ? reference : encodedReference(reference, packages))
  for (const { entry, dependencies, replacement } of references) {
    if (dependencies !== undefined) entry.dependencies = dependencies.map(encode).sort()
    if (replacement !== undefined) entry.replace = encode(replacement)
  }
}

module.exports = { versionPathPackage }
