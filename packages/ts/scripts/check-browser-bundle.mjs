import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BROWSER_ENTRIES = ['dist/index.browser.mjs', 'dist/client.mjs']

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

function specifiersOf(file) {
  const found = new Set()
  for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    found.add(match[1])
  }
  return found
}

function walk(entry) {
  const violations = []
  const seen = new Set()
  const queue = [{ file: resolve(packageRoot, entry), chain: [entry] }]

  while (queue.length > 0) {
    const { file, chain } = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)

    for (const specifier of specifiersOf(file)) {
      if (builtins.has(specifier)) {
        violations.push([...chain, specifier].join('\n      -> '))
        continue
      }
      if (!specifier.startsWith('.')) continue
      const next = resolve(dirname(file), specifier)
      if (existsSync(next)) {
        queue.push({ file: next, chain: [...chain, relative(packageRoot, next)] })
      }
    }
  }

  return violations
}

const missing = BROWSER_ENTRIES.filter(entry => !existsSync(resolve(packageRoot, entry)))
if (missing.length > 0) {
  console.error(`Browser bundle check failed; run tsup first. These entries are absent:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

let failed = false
for (const entry of BROWSER_ENTRIES) {
  const violations = walk(entry)
  if (violations.length === 0) {
    console.log(`ok  ${entry}`)
    continue
  }
  failed = true
  console.error(`FAIL ${entry} reaches ${violations.length} Node.js built-in module import(s):`)
  for (const violation of violations) console.error(`  ${violation}`)
}

if (failed) {
  console.error('\nA browser entry that reaches a Node.js built-in breaks browser bundlers (webpack, Turbopack, Vite).')
  console.error(
    'Route the Node-only code through a "#platform/*" subpath import with a browser variant (see package.json "imports").',
  )
  process.exit(1)
}

console.log(`\n${BROWSER_ENTRIES.length} browser entries reach no Node.js built-in module`)
