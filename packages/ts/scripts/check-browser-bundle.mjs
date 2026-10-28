import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { gzipSync } from 'fflate'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BROWSER_ENTRIES = [
  'dist/index.browser.mjs',
  'dist/client.mjs',
  'dist/react.mjs',
  'dist/pattern.mjs',
  'dist/partial-words.mjs',
  'dist/synonyms.mjs',
]

const SIZE_APP = 'scripts/browser-bundle-app.mjs'
const SIZE_BASELINE = 'scripts/browser-bundle-size.json'
const GZIP_LEVEL = 9

const { values: options } = parseArgs({ options: { 'update-baseline': { type: 'boolean', default: false } } })

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

async function gzippedAppBytes() {
  const bundled = await build({
    entryPoints: [resolve(packageRoot, SIZE_APP)],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['browser', 'import'],
    legalComments: 'none',
    write: false,
    logLevel: 'error',
  })
  const [output] = bundled.outputFiles
  return { minified: output.contents.length, gzipped: gzipSync(output.contents, { level: GZIP_LEVEL }).length }
}

const measured = await gzippedAppBytes()
const baselinePath = resolve(packageRoot, SIZE_BASELINE)
const described = `${SIZE_APP} bundles to ${measured.gzipped} bytes gzipped (${measured.minified} bytes minified)`

if (options['update-baseline']) {
  writeFileSync(baselinePath, `${JSON.stringify({ gzippedBytes: measured.gzipped }, null, 2)}\n`)
  console.log(`${described}, now recorded in ${SIZE_BASELINE}`)
  process.exit(0)
}

if (!existsSync(baselinePath)) {
  console.error(`${described}, and ${SIZE_BASELINE} records no size. Run this check with --update-baseline.`)
  process.exit(1)
}

const recorded = JSON.parse(readFileSync(baselinePath, 'utf8')).gzippedBytes
if (!Number.isInteger(recorded) || recorded <= 0) {
  console.error(`${SIZE_BASELINE} must hold a positive whole number in "gzippedBytes".`)
  process.exit(1)
}

if (measured.gzipped > recorded) {
  console.error(
    `FAIL ${described}, ${measured.gzipped - recorded} bytes over the ${recorded} that ${SIZE_BASELINE} records.`,
  )
  console.error(
    'An app that imports none of "@delali/narsil/pattern", "@delali/narsil/partial-words", and "@delali/narsil/synonyms" must not download more code.',
  )
  console.error(
    "Move code that only an optional feature calls behind that feature's import, or, when the growth is deliberate, run this check with --update-baseline and commit the new size.",
  )
  process.exit(1)
}

console.log(`ok  ${described}, within the ${recorded} that ${SIZE_BASELINE} records`)
if (measured.gzipped < recorded) {
  console.log(
    `The bundle shrank by ${recorded - measured.gzipped} bytes. Record the smaller size with --update-baseline.`,
  )
}
