import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearNormalizationCache, tokenize } from '../../../core/tokenizer'
import { nativeCoreAnalysis } from '../../../core/tokenizer/native-analysis'
import { nativeAnalysis } from '../../../core/tokenizer/native-hook'
import { visitSurfaceSpellings } from '../../../core/tokenizer/tokenize'
import { createNarsil } from '../../../narsil'
import type { LanguageModule } from '../../../types/language'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { loadNativeCore } from '../../../vector/native/loader'
import { seededRandom } from '../../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'
import { type LanguageFixture, languageFixtures } from '../../languages/fixtures'

const FUZZ_TEXTS_PER_LANGUAGE = 120
const MAX_FUZZ_PIECES = 12
const FIXTURE_PIECE_SHARE = 0.6
const FLAG_COMBINATIONS = 16
const TEST_TIMEOUT_MS = 120_000

const AWKWARD_PIECES = [
  'Σ',
  'ΟΔΟΣ',
  'İ',
  'ı',
  "'",
  '’',
  'ʼ',
  '̇',
  '́',
  'ͅ',
  'ß',
  'ẞ',
  'ｶﾞ',
  'Ａｂ',
  '\u{1f600}',
  '\ud800',
  '\udc00',
  '‌',
  '‍',
  '-',
  '_',
  ' ',
  '\t',
  '.',
  'ـ',
  'ً',
  'ك',
  'ھ',
  'ε',
  'ð',
  'ꞌ',
  'ş',
  'ţ',
  'љ',
  '中文字',
  'カタカナー',
  '한국어',
  'ไทย',
  'ខ្មែរ',
  'Å',
  'ǅ',
  'ﬁ',
  '\u{10400}',
  '\u{1d400}',
  '\u{e0001}',
  '0',
  'é',
  'é',
]

searchThrough('native')

interface Analysis {
  tokens: Array<{ token: string; position: number }>
  originalTokens: string[]
  surfaces?: Array<string | undefined>
  spellings: string[]
}

function fuzzTexts(fixture: LanguageFixture, texts: readonly string[]): string[] {
  const random = seededRandom(fixture.module.name.length * 7919 + 20261105)
  const pool = [...new Set([...texts.join('')])]
  const fuzzed: string[] = []
  for (let text = 0; text < FUZZ_TEXTS_PER_LANGUAGE; text++) {
    let built = ''
    const pieces = 1 + Math.floor(random() * MAX_FUZZ_PIECES)
    for (let piece = 0; piece < pieces; piece++) {
      const source = random() < FIXTURE_PIECE_SHARE ? pool : AWKWARD_PIECES
      built += source[Math.floor(random() * source.length)]
    }
    fuzzed.push(built)
  }
  return fuzzed
}

function textsOf(fixture: LanguageFixture): string[] {
  const stopWords = [...fixture.module.stopWords].join(' ')
  const texts = [
    ...fixture.samples.map(sample => sample.text),
    ...fixture.indivisible,
    ...fixture.separates.map(split => split.text),
    ...fixture.equivalent.flat(),
    ...fixture.retrievable.flatMap(item => [item.query, item.text]),
    stopWords,
    stopWords.toUpperCase(),
  ]
  return [...texts, ...fuzzTexts(fixture, texts)]
}

function analyse(text: string, module: LanguageModule, flags: number): Analysis {
  const extraStopWords = new Set([...module.stopWords].slice(0, 3))
  const result = tokenize(text, module, {
    stem: (flags & 1) !== 0,
    removeStopWords: (flags & 2) !== 0,
    removeDiacritics: (flags & 4) !== 0,
    collectSurfaces: (flags & 8) !== 0,
    stopWordOverride: flags % 3 === 0 ? extraStopWords : undefined,
  })
  const spellings: string[] = []
  visitSurfaceSpellings(text, module, spelling => spellings.push(spelling))
  return { ...result, spellings }
}

function analyseAll(fixture: LanguageFixture, texts: readonly string[], native: boolean): Analysis[] {
  setNativeSearchCoreEnabled(native)
  clearNormalizationCache()
  const results: Analysis[] = []
  for (const text of texts) {
    for (let flags = 0; flags < FLAG_COMBINATIONS; flags++) results.push(analyse(text, fixture.module, flags))
  }
  return results
}

describe.skipIf(!backendAvailable('native'))('text analysis through the native core', () => {
  const fallbacks: NativeOperation[] = []

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.shutdown()
  })

  afterAll(() => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
    clearNormalizationCache()
  })

  it('analyses every language through the core once an engine starts', () => {
    expect(nativeAnalysis()).toBe(nativeCoreAnalysis)
    for (const fixture of languageFixtures) {
      const handled = nativeCoreAnalysis.visitTokens(textsOf(fixture)[0], fixture.module, undefined, () => {})
      expect(handled, fixture.module.name).toBe(true)
    }
  })

  it('holds every language module at the revision that TypeScript records', () => {
    const core = loadNativeCore()
    expect(core).not.toBeNull()
    if (core === null) return
    const revisions = new Map<string, string>()
    for (let index = 0; index < core.languageCount(); index++) {
      revisions.set(core.languageName(index), core.languageRevision(index))
    }
    for (const fixture of languageFixtures) {
      expect(revisions.get(fixture.module.name), fixture.module.name).toBe(fixture.module.revision)
    }
  })

  for (const fixture of languageFixtures) {
    it(
      `${fixture.module.name} gives the same terms, positions, surfaces, and spellings as TypeScript`,
      () => {
        const texts = textsOf(fixture)
        const fromTypeScript = analyseAll(fixture, texts, false)
        const fromCore = analyseAll(fixture, texts, true)
        for (let index = 0; index < fromCore.length; index++) {
          const text = texts[Math.floor(index / FLAG_COMBINATIONS)]
          expect(fromCore[index], `${JSON.stringify(text)} with flags ${index % FLAG_COMBINATIONS}`).toEqual(
            fromTypeScript[index],
          )
        }
        expect(fallbacks).toEqual([])
      },
      TEST_TIMEOUT_MS,
    )
  }
})
