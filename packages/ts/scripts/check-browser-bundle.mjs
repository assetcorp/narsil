import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.browser.mjs')

let source
try {
  source = readFileSync(bundlePath, 'utf8')
} catch {
  console.error(`Browser bundle check failed: ${bundlePath} is missing; run tsup first`)
  process.exit(1)
}

const specifiers = [...new Set(builtinModules.flatMap(name => [name, `node:${name}`]))]
const escaped = specifiers.map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
const builtinReference = new RegExp(
  `(?:\\bimport\\s*\\(|\\bfrom|\\brequire\\s*\\()\\s*['"](?:${escaped.join('|')})['"]`,
)

const offenders = []
const lines = source.split('\n')
for (let i = 0; i < lines.length; i += 1) {
  const match = lines[i].match(builtinReference)
  if (match !== null) {
    offenders.push(`  line ${i + 1}: ${match[0]}`)
  }
}

if (offenders.length > 0) {
  console.error(
    'dist/index.browser.mjs references Node.js built-in modules, which breaks browser bundlers (webpack, Turbopack, Vite):',
  )
  console.error(offenders.join('\n'))
  console.error(
    'Route the Node-only code through a "#platform/*" subpath import with a browser variant (see package.json "imports").',
  )
  process.exit(1)
}

console.log('dist/index.browser.mjs contains no Node.js built-in module references')
