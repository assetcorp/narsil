import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(scriptDirectory, '..')
const DATA_PATH = join(PACKAGE_DIR, 'scripts', 'data', 'CaseFolding.txt')
const OUTPUT_PATH = join(PACKAGE_DIR, 'src', 'core', 'ordering', 'fold-table.ts')

const SPEC_UNICODE_VERSION = '17.0.0'
const SPEC_ENTRY_COUNT = 1585
const SPEC_MAX_FOLD_LENGTH = 3

interface FoldEntry {
  source: number
  fold: number[]
}

function fail(message: string): never {
  console.error(`fold-table: ${message}`)
  process.exit(1)
}

function parseCaseFolding(text: string): FoldEntry[] {
  const firstLine = text.slice(0, text.indexOf('\n'))
  if (!firstLine.includes(`CaseFolding-${SPEC_UNICODE_VERSION}.txt`)) {
    fail(
      `the data file is not CaseFolding ${SPEC_UNICODE_VERSION}; the spec pins that version, and changing it is a spec major version change`,
    )
  }

  const entries: FoldEntry[] = []
  for (const line of text.split('\n')) {
    const bare = line.split('#')[0].trim()
    if (bare.length === 0) continue
    const parts = bare.split(';').map(part => part.trim())
    if (parts.length < 3) continue
    const [code, status, mapping] = parts
    if (status !== 'C' && status !== 'F') continue
    const source = Number.parseInt(code, 16)
    const fold = mapping.split(/\s+/).map(cp => Number.parseInt(cp, 16))
    if (!Number.isInteger(source) || fold.some(cp => !Number.isInteger(cp))) {
      fail(`unparseable line: ${line}`)
    }
    entries.push({ source, fold })
  }

  entries.sort((a, b) => a.source - b.source)

  if (entries.length !== SPEC_ENTRY_COUNT) {
    fail(`expected ${SPEC_ENTRY_COUNT} C and F mappings, found ${entries.length}`)
  }
  for (const entry of entries) {
    if (entry.fold.length < 1 || entry.fold.length > SPEC_MAX_FOLD_LENGTH) {
      fail(`U+${entry.source.toString(16)} folds to ${entry.fold.length} code points, outside the spec bounds`)
    }
  }

  return entries
}

function render(entries: FoldEntry[]): string {
  const singles = entries.filter(entry => entry.fold.length === 1)
  const multis = entries.filter(entry => entry.fold.length > 1)

  let singleText = ''
  let previousSource = 0
  for (const entry of singles) {
    singleText += `${(entry.source - previousSource).toString(36)},${(entry.fold[0] - entry.source).toString(36)};`
    previousSource = entry.source
  }

  let multiText = ''
  previousSource = 0
  for (const entry of multis) {
    multiText += `${(entry.source - previousSource).toString(36)},${entry.fold.map(cp => cp.toString(36)).join(',')};`
    previousSource = entry.source
  }

  return `export const FOLD_UNICODE_VERSION = '${SPEC_UNICODE_VERSION}'

export const FOLD_ENTRY_COUNT = ${entries.length}

const SINGLE_FOLDS =
  '${singleText}'

const MULTI_FOLDS =
  '${multiText}'

let singleTable: Map<number, number> | null = null
let multiTable: Map<number, readonly number[]> | null = null

/**
 * The full case foldings that map one code point to one code point, keyed by
 * the source code point, built on first use from the packed table. Each packed
 * entry carries the delta from the previous source code point and the offset
 * from the source to its fold, both in base 36.
 */
export function singleFoldTable(): ReadonlyMap<number, number> {
  if (singleTable === null) {
    singleTable = new Map()
    let source = 0
    for (const entry of SINGLE_FOLDS.split(';')) {
      if (entry.length === 0) continue
      const [delta, offset] = entry.split(',')
      source += Number.parseInt(delta, 36)
      singleTable.set(source, source + Number.parseInt(offset, 36))
    }
  }
  return singleTable
}

/**
 * The full case foldings that expand one code point to two or three, keyed by
 * the source code point, built on first use from the packed table. Each packed
 * entry carries the delta from the previous source code point and the folded
 * code points, all in base 36.
 */
export function multiFoldTable(): ReadonlyMap<number, readonly number[]> {
  if (multiTable === null) {
    multiTable = new Map()
    let source = 0
    for (const entry of MULTI_FOLDS.split(';')) {
      if (entry.length === 0) continue
      const parts = entry.split(',')
      source += Number.parseInt(parts[0], 36)
      multiTable.set(
        source,
        parts.slice(1).map(cp => Number.parseInt(cp, 36)),
      )
    }
  }
  return multiTable
}
`
}

function main(): void {
  const write = process.argv.includes('--write')
  const data = readFileSync(DATA_PATH, 'utf-8')
  const generated = render(parseCaseFolding(data))

  if (write) {
    writeFileSync(OUTPUT_PATH, generated)
    console.log(`fold-table: wrote ${OUTPUT_PATH}`)
    return
  }

  let committed: string
  try {
    committed = readFileSync(OUTPUT_PATH, 'utf-8')
  } catch {
    fail(`missing ${OUTPUT_PATH}; run "pnpm fold-table:write" to generate it`)
  }
  if (committed !== generated) {
    fail('src/core/ordering/fold-table.ts differs from a fresh generation; run "pnpm fold-table:write"')
  }
  console.log('fold-table: the committed table matches a fresh generation')
}

main()
