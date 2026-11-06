import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NATIVE_PACKAGE_DIR } from './paths'
import type { UnicodeDatabase } from './ucd'

const HEADER_PATH = join(NATIVE_PACKAGE_DIR, 'src', 'analysis', 'unicode.h')
const SCRIPT_DEFINES_THAT_NAME_NO_SCRIPT = new Set(['SHIFT', 'MASK', 'OTHER'])

export interface PropertyLayout {
  letter: number
  mark: number
  number: number
  format: number
  cased: number
  caseIgnorable: number
  lowercaseMapping: number
  decomposes: number
  composesSecond: number
  compositionExcluded: number
  scriptShift: number
  maxDecomposition: number
  scripts: Map<string, number>
}

function headerDefines(): Map<string, string> {
  const defines = new Map<string, string>()
  for (const match of readFileSync(HEADER_PATH, 'utf-8').matchAll(/^#define (NARSIL_UNICODE_\w+) (.+)$/gm)) {
    defines.set(match[1], match[2].trim())
  }
  return defines
}

function flagBit(defines: Map<string, string>, name: string): number {
  const value = defines.get(`NARSIL_UNICODE_${name}`)
  const match = value === undefined ? null : /^\(1U << (\d+)\)$/.exec(value)
  if (match === null) throw new Error(`unicode.h defines no flag NARSIL_UNICODE_${name} of the form (1U << n)`)
  return 1 << Number(match[1])
}

function plainNumber(defines: Map<string, string>, name: string): number {
  const value = Number(defines.get(`NARSIL_UNICODE_${name}`))
  if (!Number.isInteger(value)) throw new Error(`unicode.h defines no number NARSIL_UNICODE_${name}`)
  return value
}

export function readPropertyLayout(): PropertyLayout {
  const defines = headerDefines()
  const scripts = new Map<string, number>()
  for (const [name, value] of defines) {
    const match = /^NARSIL_UNICODE_SCRIPT_([A-Z]+)$/.exec(name)
    if (match === null || SCRIPT_DEFINES_THAT_NAME_NO_SCRIPT.has(match[1])) continue
    const scriptName = match[1].charAt(0) + match[1].slice(1).toLowerCase()
    scripts.set(scriptName, Number(value))
  }
  return {
    letter: flagBit(defines, 'LETTER'),
    mark: flagBit(defines, 'MARK'),
    number: flagBit(defines, 'NUMBER'),
    format: flagBit(defines, 'FORMAT'),
    cased: flagBit(defines, 'CASED'),
    caseIgnorable: flagBit(defines, 'CASE_IGNORABLE'),
    lowercaseMapping: flagBit(defines, 'LOWERCASE_MAPPING'),
    decomposes: flagBit(defines, 'DECOMPOSES'),
    composesSecond: flagBit(defines, 'COMPOSES_SECOND'),
    compositionExcluded: flagBit(defines, 'COMPOSITION_EXCLUDED'),
    scriptShift: plainNumber(defines, 'SCRIPT_SHIFT'),
    maxDecomposition: plainNumber(defines, 'MAX_DECOMPOSITION'),
    scripts,
  }
}

export function propertyValue(codePoint: number, database: UnicodeDatabase, layout: PropertyLayout): number {
  const record = database.records.get(codePoint)
  const has = (name: string) => database.binaryProperties.get(name)?.has(codePoint) ?? false
  let value = record?.combiningClass ?? 0
  const category = record?.generalCategory ?? 'Cn'
  if (category.startsWith('L')) value |= layout.letter
  if (category.startsWith('M')) value |= layout.mark
  if (category.startsWith('N')) value |= layout.number
  if (category === 'Cf') value |= layout.format
  if (has('Cased')) value |= layout.cased
  if (has('Case_Ignorable')) value |= layout.caseIgnorable
  if (has('Full_Composition_Exclusion')) value |= layout.compositionExcluded
  const lower = database.specialLowercase.get(codePoint) ?? [record?.simpleLowercase ?? codePoint]
  if (lower.length !== 1 || lower[0] !== codePoint) value |= layout.lowercaseMapping
  if (record?.decomposition) value |= layout.decomposes
  const script = database.scripts.get(codePoint)
  if (script !== undefined) {
    const id = layout.scripts.get(script)
    if (id === undefined) throw new Error(`unicode.h defines no NARSIL_UNICODE_SCRIPT_ for ${script}`)
    value |= id << layout.scriptShift
  }
  return value >>> 0
}
