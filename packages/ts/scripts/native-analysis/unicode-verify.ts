import { UNICODE_MAX_CODE_POINT, UNICODE_VERSION, type UnicodeDatabase } from './ucd'
import { type PropertyLayout, propertyValue } from './unicode-properties'

const HANGUL_SYLLABLE_FIRST = 0xac00
const HANGUL_SYLLABLE_LAST = 0xd7a3
const HANGUL_LEADING_FIRST = 0x1100
const HANGUL_VOWEL_FIRST = 0x1161
const HANGUL_TRAILING_BEFORE_FIRST = 0x11a7
const HANGUL_VOWEL_COUNT = 21
const HANGUL_TRAILING_COUNT = 28
const LATIN_SMALL_A = 0x61
const ORDERING_PROBES = [0x0334, 0x0301, 0x0345]
const MAX_REPORTED_MISMATCHES = 20

function fullDecomposition(codePoint: number, database: UnicodeDatabase): number[] {
  if (codePoint >= HANGUL_SYLLABLE_FIRST && codePoint <= HANGUL_SYLLABLE_LAST) {
    const index = codePoint - HANGUL_SYLLABLE_FIRST
    const leading = HANGUL_LEADING_FIRST + Math.floor(index / (HANGUL_VOWEL_COUNT * HANGUL_TRAILING_COUNT))
    const vowel =
      HANGUL_VOWEL_FIRST + Math.floor((index % (HANGUL_VOWEL_COUNT * HANGUL_TRAILING_COUNT)) / HANGUL_TRAILING_COUNT)
    const trailing = index % HANGUL_TRAILING_COUNT
    return trailing === 0 ? [leading, vowel] : [leading, vowel, HANGUL_TRAILING_BEFORE_FIRST + trailing]
  }
  const decomposition = database.records.get(codePoint)?.decomposition
  if (!decomposition) return [codePoint]
  return decomposition.flatMap(part => fullDecomposition(part, database))
}

function expectedLowercase(codePoint: number, database: UnicodeDatabase): number[] {
  return database.specialLowercase.get(codePoint) ?? [database.records.get(codePoint)?.simpleLowercase ?? codePoint]
}

function sameCodePoints(text: string, expected: number[]): boolean {
  return text === String.fromCodePoint(...expected)
}

export function verifyAgainstThisEngine(database: UnicodeDatabase, layout: PropertyLayout): void {
  const engineVersion = process.versions.unicode
  if (`${engineVersion}.0` !== UNICODE_VERSION) {
    throw new Error(
      `this Node.js uses Unicode ${engineVersion}, so it cannot check tables for Unicode ${UNICODE_VERSION}; run the generator under a Node.js release that uses Unicode ${UNICODE_VERSION}`,
    )
  }
  const flags: Array<[number, RegExp]> = [
    [layout.letter, /^\p{L}$/u],
    [layout.mark, /^\p{M}$/u],
    [layout.number, /^\p{N}$/u],
    [layout.format, /^\p{Cf}$/u],
    [layout.cased, /^\p{Cased}$/u],
    [layout.caseIgnorable, /^\p{Case_Ignorable}$/u],
  ]
  const scripts = [...layout.scripts].map(([name, id]) => [id, new RegExp(`^\\p{Script=${name}}$`, 'u')] as const)
  const mismatches: string[] = []
  const mismatch = (codePoint: number, what: string) => {
    if (mismatches.length < MAX_REPORTED_MISMATCHES) mismatches.push(`U+${codePoint.toString(16)}: ${what}`)
  }
  for (let codePoint = 0; codePoint <= UNICODE_MAX_CODE_POINT; codePoint++) {
    const text = String.fromCodePoint(codePoint)
    const record = database.records.get(codePoint)
    let value = record?.combiningClass ?? 0
    for (const [bit, pattern] of flags) if (pattern.test(text)) value |= bit
    for (const [id, pattern] of scripts) if (pattern.test(text)) value |= id << layout.scriptShift
    const mask = flags.reduce((all, [bit]) => all | bit, 0xff) | (0xf << layout.scriptShift)
    const derived = propertyValue(codePoint, database, layout) & mask
    if ((value & mask) !== derived) mismatch(codePoint, `properties ${value & mask} against ${derived}`)
    if (!sameCodePoints(text.toLowerCase(), expectedLowercase(codePoint, database))) mismatch(codePoint, 'lowercase')
    if (!sameCodePoints(text.normalize('NFD'), fullDecomposition(codePoint, database))) mismatch(codePoint, 'NFD')
    const combining = record?.combiningClass ?? 0
    if (combining > 0 && !record?.decomposition) {
      for (const probe of ORDERING_PROBES) {
        const probeClass = database.records.get(probe)?.combiningClass ?? 0
        const ordered = combining > probeClass ? [LATIN_SMALL_A, probe, codePoint] : [LATIN_SMALL_A, codePoint, probe]
        const reordered = String.fromCodePoint(LATIN_SMALL_A, codePoint, probe).normalize('NFD')
        if (combining !== probeClass && !sameCodePoints(reordered, ordered)) mismatch(codePoint, 'canonical order')
      }
    }
  }
  const excluded = database.binaryProperties.get('Full_Composition_Exclusion') ?? new Set()
  for (const [codePoint, record] of database.records) {
    if (record.decomposition?.length !== 2 || excluded.has(codePoint)) continue
    const composed = String.fromCodePoint(...fullDecomposition(codePoint, database)).normalize('NFC')
    if (!sameCodePoints(composed, [codePoint])) mismatch(codePoint, 'NFC composition')
  }
  if (mismatches.length > 0) {
    throw new Error(`the tables disagree with this engine:\n${mismatches.join('\n')}`)
  }
  console.log(`the Unicode ${UNICODE_VERSION} tables agree with this Node.js on every code point`)
}
