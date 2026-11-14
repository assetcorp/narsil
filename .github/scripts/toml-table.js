function escapedForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tableKeyPattern(table, key) {
  const header = escapedForPattern(`[${table}]`)
  return new RegExp(`(^${header}\\s*$(?:(?!^\\[)[\\s\\S])*?^${key}\\s*=\\s*")([^"]+)(")`, 'm')
}

module.exports = { escapedForPattern, tableKeyPattern }
