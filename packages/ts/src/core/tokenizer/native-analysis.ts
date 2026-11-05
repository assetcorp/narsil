import { loadNativeCore } from '#platform/native-core'
import type { LanguageModule } from '../../types/language'
import type { NativeStopWordSetHandle } from '../../vector/native/analysis-types'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import type { NativeAnalysis } from './native-hook'
import type { TokenizeOptions, TokenVisitor } from './tokenize'

const STEM_FLAG = 1
const REMOVE_STOP_WORDS_FLAG = 2
const REMOVE_DIACRITICS_FLAG = 4
const COLLECT_SURFACES_FLAG = 8
const SPELLINGS_FLAG = 16
const TOKEN_RECORD_WORDS = 7
const NO_SURFACE = 0xffffffff
const FIRST_RECORD_TOKENS = 256

interface CoreLanguage {
  index: number
  moduleStopWords: NativeStopWordSetHandle | null
}

interface HeldStopWords {
  handle: NativeStopWordSetHandle
  size: number
}

interface Analysed {
  arena: string
  records: Uint32Array
}

let coreOfNames: NativeCore | null = null
let indexByName = new Map<string, number>()
let languagesOfCore = new WeakMap<LanguageModule, CoreLanguage | null>()
let heldStopWords = new WeakMap<ReadonlySet<string>, HeldStopWords>()
let sharedRecords = new Uint32Array(1 + FIRST_RECORD_TOKENS * TOKEN_RECORD_WORDS)
let recordsInUse = false

function activeCore(): NativeCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) return null
  if (core !== coreOfNames) {
    coreOfNames = core
    indexByName = new Map()
    languagesOfCore = new WeakMap()
    heldStopWords = new WeakMap()
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

function heldSetFor(core: NativeCore, words: ReadonlySet<string>): NativeStopWordSetHandle {
  const held = heldStopWords.get(words)
  if (held !== undefined && held.size === words.size) return held.handle
  const handle = core.createStopWordSet(stringsOf(words))
  heldStopWords.set(words, { handle, size: words.size })
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
  return heldSetFor(core, words)
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

function visitRecords(analysed: Analysed, visit: TokenVisitor): void {
  const { arena, records } = analysed
  const count = records[0]
  const ownsShared = records === sharedRecords
  if (ownsShared) recordsInUse = true
  try {
    for (let token = 0, at = 1; token < count; token++, at += TOKEN_RECORD_WORDS) {
      const termStart = records[at + 1]
      const surfaceStart = records[at + 3]
      const originalStart = records[at + 5]
      visit(
        arena.substring(termStart, termStart + records[at + 2]),
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
  visitRecords(analysed, spelling => visit(spelling))
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
