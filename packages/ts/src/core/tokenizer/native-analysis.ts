import { loadNativeCore } from '#platform/native-core'
import type { LanguageModule } from '../../types/language'
import type { NativeStopWordSetHandle } from '../../vector/native/analysis-types'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import {
  NATIVE_ANALYSIS_FIRST_PACKED_UNITS,
  NATIVE_ANALYSIS_FIRST_TOKEN_RECORDS,
  NATIVE_ANALYSIS_HELD_TERMS,
} from './constants'
import type { NativeAnalysis, PackedTokenVisitor } from './native-hook'
import type { TokenizeOptions, TokenVisitor } from './tokenize'

const STEM_FLAG = 1
const REMOVE_STOP_WORDS_FLAG = 2
const REMOVE_DIACRITICS_FLAG = 4
const COLLECT_SURFACES_FLAG = 8
const SPELLINGS_FLAG = 16
const TOKEN_RECORD_WORDS = 8
const NO_SURFACE = 0xffffffff
const COPY_PREFIX = ' '

interface CoreLanguage {
  index: number
  moduleStopWords: NativeStopWordSetHandle | null
}

interface HeldStopWords {
  handle: NativeStopWordSetHandle
  words: ReadonlySet<string>
}

interface Analysed {
  arena: string
  records: Uint32Array
}

let coreOfNames: NativeCore | null = null
let indexByName = new Map<string, number>()
let languagesOfCore = new WeakMap<LanguageModule, CoreLanguage | null>()
let heldStopWords = new WeakMap<object, HeldStopWords>()
let sharedRecords = new Uint32Array(1 + NATIVE_ANALYSIS_FIRST_TOKEN_RECORDS * TOKEN_RECORD_WORDS)
let recordsInUse = false
let packedRecords = new Uint32Array(1 + NATIVE_ANALYSIS_FIRST_TOKEN_RECORDS * TOKEN_RECORD_WORDS)
let packedUnits = new Uint16Array(NATIVE_ANALYSIS_FIRST_PACKED_UNITS)
let packedInUse = false
let termsBySlot: Array<string | undefined> | null = null

function activeCore(): NativeCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) return null
  if (core !== coreOfNames) {
    coreOfNames = core
    indexByName = new Map()
    languagesOfCore = new WeakMap()
    heldStopWords = new WeakMap()
    termsBySlot = null
    const count = core.languageCount()
    for (let index = 0; index < count; index++) indexByName.set(core.languageName(index), index)
  }
  return core
}

function stringsOf(words: ReadonlySet<unknown>): string[] {
  const strings: string[] = []
  for (const word of words) if (typeof word === 'string') strings.push(word)
  return strings
}

function holdsTheCoreList(core: NativeCore, index: number, words: ReadonlySet<string>): boolean {
  const coreWords = core.languageStopWords(index)
  if (coreWords.length !== words.size) return false
  for (const word of coreWords) if (!words.has(word)) return false
  return true
}

function coreLanguageOf(core: NativeCore, module: LanguageModule): CoreLanguage | null {
  const known = languagesOfCore.get(module)
  if (known !== undefined) return known
  const index = indexByName.get(module.name)
  let language: CoreLanguage | null = null
  if (index !== undefined && core.languageRevision(index) === module.revision) {
    const moduleStopWords = holdsTheCoreList(core, index, module.stopWords)
      ? null
      : core.createStopWordSet(stringsOf(module.stopWords))
    language = { index, moduleStopWords }
  }
  languagesOfCore.set(module, language)
  return language
}

export function nativeCoreLanguage(language: LanguageModule): { core: NativeCore; index: number } | null {
  const core = activeCore()
  if (core === null) return null
  const selected = coreLanguageOf(core, language)
  return selected === null ? null : { core, index: selected.index }
}

function holdsTheSameWords(held: ReadonlySet<string>, words: ReadonlySet<unknown>): boolean {
  let strings = 0
  for (const word of words) {
    if (typeof word !== 'string') continue
    if (!held.has(word)) return false
    strings++
  }
  return strings === held.size
}

function heldSetFor(core: NativeCore, owner: object, words: ReadonlySet<string>): NativeStopWordSetHandle {
  const held = heldStopWords.get(owner)
  if (held !== undefined && holdsTheSameWords(held.words, words)) return held.handle
  const strings = stringsOf(words)
  const handle = core.createStopWordSet(strings)
  heldStopWords.set(owner, { handle, words: new Set(strings) })
  return handle
}

function stopWordsFor(
  core: NativeCore,
  language: CoreLanguage,
  module: LanguageModule,
  override: TokenizeOptions['stopWordOverride'],
): NativeStopWordSetHandle | null {
  if (!override) return language.moduleStopWords
  const words = override instanceof Set ? override : override(module.stopWords)
  if (words === module.stopWords) return language.moduleStopWords
  return heldSetFor(core, override, words)
}

function visitPacked(
  core: NativeCore,
  index: number,
  flags: number,
  text: string,
  stopWords: NativeStopWordSetHandle | null,
  packed: PackedTokenVisitor,
): boolean {
  const shared = !packedInUse
  let records = shared ? packedRecords : new Uint32Array(packedRecords.length)
  let units = shared ? packedUnits : new Uint16Array(packedUnits.length)
  let written = core.analysePacked(index, flags, text, stopWords, records, units)
  if (written === null) {
    const neededUnits = records[1]
    records = new Uint32Array(Math.max(records.length, 1 + records[0] * TOKEN_RECORD_WORDS))
    units = new Uint16Array(Math.max(units.length, neededUnits))
    if (shared) {
      packedRecords = records
      packedUnits = units
    }
    written = core.analysePacked(index, flags, text, stopWords, records, units)
  }
  const count = records[0]
  if (
    typeof written !== 'number' ||
    written < 0 ||
    written > units.length ||
    count > (records.length - 1) / TOKEN_RECORD_WORDS
  ) {
    noteFallback('analyse')
    return false
  }
  if (shared) packedInUse = true
  try {
    packed(records, count, units, written)
  } finally {
    if (shared) packedInUse = false
  }
  return true
}

function analyseWith(
  core: NativeCore,
  index: number,
  flags: number,
  text: string,
  stopWords: NativeStopWordSetHandle | null,
): Analysed | null {
  let records = recordsInUse ? new Uint32Array(sharedRecords.length) : sharedRecords
  let result = core.analyse(index, flags, text, stopWords, records)
  if (result === null) {
    records = new Uint32Array(1 + records[0] * TOKEN_RECORD_WORDS)
    if (!recordsInUse) sharedRecords = records
    result = core.analyse(index, flags, text, stopWords, records)
  }
  if (typeof result !== 'string') {
    noteFallback('analyse')
    return null
  }
  return { arena: result, records }
}

function holdsUnits(held: string, arena: string, start: number, length: number): boolean {
  if (held.length !== length) return false
  for (let unit = 0; unit < length; unit++) {
    if (held.charCodeAt(unit) !== arena.charCodeAt(start + unit)) return false
  }
  return true
}

function termOf(arena: string, start: number, length: number, slot: number): string {
  if (slot >= NATIVE_ANALYSIS_HELD_TERMS) return arena.substring(start, start + length)
  if (termsBySlot === null) termsBySlot = new Array<string | undefined>(NATIVE_ANALYSIS_HELD_TERMS)
  const held = termsBySlot[slot]
  if (held !== undefined && holdsUnits(held, arena, start, length)) return held
  const term = (COPY_PREFIX + arena.substring(start, start + length)).slice(COPY_PREFIX.length)
  termsBySlot[slot] = term
  return term
}

function visitRecords(analysed: Analysed, visit: TokenVisitor): void {
  const { arena, records } = analysed
  const count = records[0]
  const ownsShared = records === sharedRecords
  if (ownsShared) recordsInUse = true
  try {
    for (let token = 0, at = 1; token < count; token++, at += TOKEN_RECORD_WORDS) {
      const surfaceStart = records[at + 3]
      const originalStart = records[at + 5]
      visit(
        termOf(arena, records[at + 1], records[at + 2], records[at + 7]),
        records[at],
        surfaceStart === NO_SURFACE ? undefined : arena.substring(surfaceStart, surfaceStart + records[at + 4]),
        arena.substring(originalStart, originalStart + records[at + 6]),
      )
    }
  } finally {
    if (ownsShared) recordsInUse = false
  }
}

function visitTokens(
  text: string,
  language: LanguageModule,
  options: TokenizeOptions | undefined,
  visit: TokenVisitor,
  packed?: PackedTokenVisitor,
): boolean {
  const core = activeCore()
  if (core === null) return false
  const coreLanguage = coreLanguageOf(core, language)
  if (coreLanguage === null) return false
  const removeStopWords = options?.removeStopWords ?? true
  const flags =
    ((options?.stem ?? true) ? STEM_FLAG : 0) |
    (removeStopWords ? REMOVE_STOP_WORDS_FLAG : 0) |
    (options?.removeDiacritics === true ? REMOVE_DIACRITICS_FLAG : 0) |
    (options?.collectSurfaces === true ? COLLECT_SURFACES_FLAG : 0)
  const stopWords = removeStopWords ? stopWordsFor(core, coreLanguage, language, options?.stopWordOverride) : null
  if (packed !== undefined) return visitPacked(core, coreLanguage.index, flags, text, stopWords, packed)
  const analysed = analyseWith(core, coreLanguage.index, flags, text, stopWords)
  if (analysed === null) return false
  visitRecords(analysed, visit)
  return true
}

function visitSpellings(text: string, language: LanguageModule, visit: (spelling: string) => void): boolean {
  const core = activeCore()
  if (core === null) return false
  const coreLanguage = coreLanguageOf(core, language)
  if (coreLanguage === null) return false
  const analysed = analyseWith(core, coreLanguage.index, SPELLINGS_FLAG, text, null)
  if (analysed === null) return false
  const { arena, records } = analysed
  const count = records[0]
  const ownsShared = records === sharedRecords
  if (ownsShared) recordsInUse = true
  try {
    for (let token = 0, at = 1; token < count; token++, at += TOKEN_RECORD_WORDS)
      visit(termOf(arena, records[at + 1], records[at + 2], records[at + 7]))
  } finally {
    if (ownsShared) recordsInUse = false
  }
  return true
}

function transform(raw: string, language: LanguageModule, stem: boolean, removeDiacritics: boolean): string | null {
  const core = activeCore()
  if (core === null) return null
  const coreLanguage = coreLanguageOf(core, language)
  if (coreLanguage === null) return null
  const result = core.transform(
    coreLanguage.index,
    (stem ? STEM_FLAG : 0) | (removeDiacritics ? REMOVE_DIACRITICS_FLAG : 0),
    raw,
  )
  if (typeof result === 'string') return result
  noteFallback('analyse')
  return null
}

export const nativeCoreAnalysis: NativeAnalysis = { visitTokens, visitSpellings, transform }
