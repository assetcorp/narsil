import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { constArray, type GeneratedFile, writeOrCheck } from './c-source'
import { NATIVE_PACKAGE_DIR, TS_PACKAGE_DIR } from './paths'
import { loadUnicodeDatabase, UNICODE_MAX_CODE_POINT, UNICODE_VERSION, type UnicodeDatabase } from './ucd'
import { type PropertyLayout, propertyValue, readPropertyLayout } from './unicode-properties'
import { verifyAgainstThisEngine } from './unicode-verify'

const TABLES_DIR = join(NATIVE_PACKAGE_DIR, 'src', 'unicode')
const CACHE_DIR = join(TS_PACKAGE_DIR, 'node_modules', '.cache', 'narsil-unicode', UNICODE_VERSION)
const MAX_PROPERTY_VALUES = 256
const RUN_INDEX_BITS = 8
const SPECIAL_LOWERCASE_LENGTH = 2

function compositionSeconds(database: UnicodeDatabase): Set<number> {
  const seconds = new Set<number>()
  const excluded = database.binaryProperties.get('Full_Composition_Exclusion') ?? new Set()
  for (const [codePoint, record] of database.records) {
    if (record.decomposition?.length === 2 && !excluded.has(codePoint)) seconds.add(record.decomposition[1])
  }
  return seconds
}

function propertyTables(database: UnicodeDatabase, layout: PropertyLayout): { values: number[]; runs: number[] } {
  const seconds = compositionSeconds(database)
  const values: number[] = []
  const indexOf = new Map<number, number>()
  const runs: number[] = []
  let runIndex = -1
  let runLength = 0
  for (let codePoint = 0; codePoint <= UNICODE_MAX_CODE_POINT; codePoint++) {
    let value = propertyValue(codePoint, database, layout)
    if (seconds.has(codePoint)) value = (value | layout.composesSecond) >>> 0
    let index = indexOf.get(value)
    if (index === undefined) {
      index = values.length
      values.push(value)
      indexOf.set(value, index)
    }
    if (index === runIndex) {
      runLength++
      continue
    }
    if (runIndex >= 0) runs.push(runLength * (1 << RUN_INDEX_BITS) + runIndex)
    runIndex = index
    runLength = 1
  }
  runs.push(runLength * (1 << RUN_INDEX_BITS) + runIndex)
  if (values.length > MAX_PROPERTY_VALUES) {
    throw new Error(`${values.length} distinct property values overflow the ${RUN_INDEX_BITS}-bit run index`)
  }
  return { values, runs }
}

function lowercaseTables(database: UnicodeDatabase): { pairs: number[]; special: number[] } {
  const pairs: number[] = []
  const special: number[] = []
  for (let codePoint = 0; codePoint <= UNICODE_MAX_CODE_POINT; codePoint++) {
    const full = database.specialLowercase.get(codePoint)
    if (full !== undefined && full.length > 1) {
      if (full.length !== SPECIAL_LOWERCASE_LENGTH) {
        throw new Error(`U+${codePoint.toString(16)} lowercases to ${full.length} code points`)
      }
      special.push(codePoint, ...full)
      continue
    }
    const lower = full?.[0] ?? database.records.get(codePoint)?.simpleLowercase ?? codePoint
    if (lower !== codePoint) pairs.push(codePoint, lower)
  }
  if (database.finalSigmaCodePoints.length !== 1 || database.finalSigmaCodePoints[0] !== 0x3a3) {
    throw new Error('SpecialCasing.txt gives Final_Sigma to a code point other than U+03A3')
  }
  return { pairs, special }
}

function decompositionTable(database: UnicodeDatabase, layout: PropertyLayout): number[] {
  const entries: number[] = []
  const codePoints = [...database.records.keys()].sort((a, b) => a - b)
  for (const codePoint of codePoints) {
    const decomposition = database.records.get(codePoint)?.decomposition
    if (!decomposition) continue
    if (decomposition.length > 2) throw new Error(`U+${codePoint.toString(16)} decomposes into more than two`)
    entries.push(codePoint, decomposition[0], decomposition[1] ?? 0)
  }
  const fullLength = (codePoint: number): number => {
    const decomposition = database.records.get(codePoint)?.decomposition
    return decomposition ? decomposition.reduce((total, part) => total + fullLength(part), 0) : 1
  }
  const longest = codePoints.reduce((most, codePoint) => Math.max(most, fullLength(codePoint)), 0)
  if (longest > layout.maxDecomposition) {
    throw new Error(`a code point decomposes into ${longest}, past NARSIL_UNICODE_MAX_DECOMPOSITION`)
  }
  return entries
}

function fileText(body: string): string {
  return `#include "../analysis/unicode.h"\n\n#include <stdint.h>\n\n${body}`
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write')
  const layout = readPropertyLayout()
  const database = await loadUnicodeDatabase(CACHE_DIR, [...layout.scripts.keys()])
  const { values, runs } = propertyTables(database, layout)
  const { pairs, special } = lowercaseTables(database)
  const decompositions = decompositionTable(database, layout)
  const files: GeneratedFile[] = [
    {
      path: join(TABLES_DIR, 'properties.c'),
      text: fileText(
        `${constArray('uint32_t', 'narsil_unicode_property_values', values)}\n${constArray('uint32_t', 'narsil_unicode_property_runs', runs)}`,
      ),
    },
    {
      path: join(TABLES_DIR, 'lowercase.c'),
      text: fileText(
        `${constArray('uint32_t', 'narsil_unicode_lowercase', pairs)}\n${constArray('uint32_t', 'narsil_unicode_special_lowercase', special)}`,
      ),
    },
    {
      path: join(TABLES_DIR, 'decompositions.c'),
      text: fileText(constArray('uint32_t', 'narsil_unicode_decompositions', decompositions)),
    },
  ]
  verifyAgainstThisEngine(database, layout)
  if (write) mkdirSync(TABLES_DIR, { recursive: true })
  process.exit(writeOrCheck(files, NATIVE_PACKAGE_DIR, write))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
