import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const UNICODE_VERSION = '17.0.0'
export const UNICODE_MAX_CODE_POINT = 0x10ffff

const UCD_BASE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`

const PINNED_FILES: Record<string, string> = {
  'UnicodeData.txt': '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c',
  'SpecialCasing.txt': 'efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588',
  'DerivedCoreProperties.txt': '24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08',
  'DerivedNormalizationProps.txt': '71fd6a206a2c0cdd41feb6b7f656aa31091db45e9cedc926985d718397f9e488',
  'Scripts.txt': '9f5e50d3abaee7d6ce09480f325c706f485ae3240912527e651954d2d6b035bf',
}

export interface CodePointRecord {
  generalCategory: string
  combiningClass: number
  decomposition: number[] | null
  simpleLowercase: number | null
}

export interface UnicodeDatabase {
  records: Map<number, CodePointRecord>
  specialLowercase: Map<number, number[]>
  finalSigmaCodePoints: number[]
  binaryProperties: Map<string, Set<number>>
  scripts: Map<number, string>
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fetchPinned(cacheDirectory: string, name: string): Promise<string> {
  const expected = PINNED_FILES[name]
  const cached = join(cacheDirectory, name)
  if (existsSync(cached)) {
    const bytes = readFileSync(cached)
    if (sha256(bytes) === expected) return bytes.toString('utf-8')
  }
  const response = await fetch(`${UCD_BASE_URL}/${name}`)
  if (!response.ok) throw new Error(`fetching ${name} from unicode.org answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${name} has digest ${actual}, while the generator pins ${expected}`)
  mkdirSync(cacheDirectory, { recursive: true })
  writeFileSync(cached, bytes)
  return bytes.toString('utf-8')
}

function dataLines(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    const bare = line.split('#')[0].trim()
    if (bare.length === 0) continue
    rows.push(bare.split(';').map(field => field.trim()))
  }
  return rows
}

function hex(field: string): number {
  const value = Number.parseInt(field, 16)
  if (!Number.isInteger(value) || value < 0 || value > UNICODE_MAX_CODE_POINT) {
    throw new Error(`"${field}" is no code point`)
  }
  return value
}

function codePointList(field: string): number[] {
  return field
    .split(/\s+/)
    .filter(part => part.length > 0)
    .map(hex)
}

function rangeOf(field: string): [number, number] {
  const [first, last] = field.split('..')
  return [hex(first), last === undefined ? hex(first) : hex(last)]
}

function parseUnicodeData(text: string): Map<number, CodePointRecord> {
  const records = new Map<number, CodePointRecord>()
  let rangeStart: number | null = null
  for (const fields of dataLines(text)) {
    const codePoint = hex(fields[0])
    const decompositionField = fields[5]
    const record: CodePointRecord = {
      generalCategory: fields[2],
      combiningClass: Number(fields[3]),
      decomposition:
        decompositionField.length > 0 && !decompositionField.startsWith('<') ? codePointList(decompositionField) : null,
      simpleLowercase: fields[13].length > 0 ? hex(fields[13]) : null,
    }
    if (fields[1].endsWith(', First>')) {
      rangeStart = codePoint
      continue
    }
    if (fields[1].endsWith(', Last>')) {
      if (rangeStart === null) throw new Error(`UnicodeData.txt closes a range at ${fields[0]} that it never opened`)
      for (let member = rangeStart; member <= codePoint; member++) records.set(member, { ...record })
      rangeStart = null
      continue
    }
    records.set(codePoint, record)
  }
  return records
}

function parseSpecialCasing(text: string): { lower: Map<number, number[]>; finalSigma: number[] } {
  const lower = new Map<number, number[]>()
  const finalSigma: number[] = []
  for (const fields of dataLines(text)) {
    const codePoint = hex(fields[0])
    const condition = fields[4] ?? ''
    if (condition === 'Final_Sigma') {
      finalSigma.push(codePoint)
      continue
    }
    if (condition.length > 0) continue
    lower.set(codePoint, codePointList(fields[1]))
  }
  return { lower, finalSigma }
}

function parseBinaryProperties(texts: string[], wanted: string[]): Map<string, Set<number>> {
  const properties = new Map(wanted.map(name => [name, new Set<number>()]))
  for (const text of texts) {
    for (const fields of dataLines(text)) {
      const members = properties.get(fields[1])
      if (members === undefined) continue
      const [first, last] = rangeOf(fields[0])
      for (let member = first; member <= last; member++) members.add(member)
    }
  }
  return properties
}

function parseScripts(text: string, wanted: string[]): Map<number, string> {
  const scripts = new Map<number, string>()
  for (const fields of dataLines(text)) {
    if (!wanted.includes(fields[1])) continue
    const [first, last] = rangeOf(fields[0])
    for (let member = first; member <= last; member++) scripts.set(member, fields[1])
  }
  return scripts
}

export async function loadUnicodeDatabase(cacheDirectory: string, scriptNames: string[]): Promise<UnicodeDatabase> {
  const unicodeData = await fetchPinned(cacheDirectory, 'UnicodeData.txt')
  const specialCasing = await fetchPinned(cacheDirectory, 'SpecialCasing.txt')
  const coreProperties = await fetchPinned(cacheDirectory, 'DerivedCoreProperties.txt')
  const normalizationProperties = await fetchPinned(cacheDirectory, 'DerivedNormalizationProps.txt')
  const scriptData = await fetchPinned(cacheDirectory, 'Scripts.txt')
  const casing = parseSpecialCasing(specialCasing)
  return {
    records: parseUnicodeData(unicodeData),
    specialLowercase: casing.lower,
    finalSigmaCodePoints: casing.finalSigma,
    binaryProperties: parseBinaryProperties(
      [coreProperties, normalizationProperties],
      ['Cased', 'Case_Ignorable', 'Full_Composition_Exclusion'],
    ),
    scripts: parseScripts(scriptData, scriptNames),
  }
}
