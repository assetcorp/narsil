import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearNormalizationCache, type TokenizeOptions, tokenize } from '../../core/tokenizer'
import { nativeCoreLanguage } from '../../core/tokenizer/native-analysis'
import { visitSurfaceSpellings } from '../../core/tokenizer/tokenize'
import { registerLanguage } from '../../languages/registry'
import { createNarsil, type Narsil } from '../../narsil'
import type { LanguageModule } from '../../types/language'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { backendAvailable, searchThrough } from '../integration/filtered-vectors/search-backend'
import { type LanguageFixture, languageFixtures } from './fixtures'

const OPTION_SETS: readonly TokenizeOptions[] = [
  {},
  { stem: false },
  { removeStopWords: false },
  { stem: false, removeStopWords: false },
  { collectSurfaces: true },
  { collectSurfaces: true, removeStopWords: false },
  { removeDiacritics: true },
  { removeDiacritics: true, collectSurfaces: true, removeStopWords: false },
]

interface Analysed {
  tokens: Array<{ token: string; position: number }>
  originalTokens: string[]
  surfaces?: Array<string | undefined>
  spellings: string[]
}

searchThrough('native')

function textsOf(fixture: LanguageFixture): string[] {
  return [
    ...fixture.samples.map(sample => sample.text),
    ...fixture.indivisible,
    ...fixture.separates.map(split => split.text),
    ...fixture.equivalent.flat(),
    ...fixture.retrievable.flatMap(entry => [entry.query, entry.text]),
    [...fixture.module.stopWords].join(' \n '),
    [...fixture.module.stopWords].map(word => word.toUpperCase()).join(' , '),
  ]
}

function analyse(text: string, module: LanguageModule, options: TokenizeOptions, native: boolean): Analysed {
  setNativeSearchCoreEnabled(native)
  clearNormalizationCache()
  const result = tokenize(text, module, options)
  const spellings: string[] = []
  visitSurfaceSpellings(text, module, spelling => spellings.push(spelling))
  return { ...result, spellings }
}

describe.skipIf(!backendAvailable('native'))(
  'every language analyses text alike in the C core and in TypeScript',
  () => {
    const fallbacks: NativeOperation[] = []
    let narsil: Narsil

    beforeAll(async () => {
      observeFallbacks(operation => fallbacks.push(operation))
      narsil = await createNarsil({ workers: { enabled: false } })
    })

    afterAll(async () => {
      observeFallbacks(null)
      setNativeSearchCoreEnabled(true)
      clearNormalizationCache()
      await narsil.shutdown()
      expect(fallbacks).toEqual([])
    })

    for (const fixture of languageFixtures) {
      const module = fixture.module

      it(`${module.name} matches token for token`, () => {
        registerLanguage(module)
        setNativeSearchCoreEnabled(true)
        expect(
          nativeCoreLanguage(module),
          `the C core holds ${module.name} at revision ${module.revision}`,
        ).not.toBeNull()
        for (const text of textsOf(fixture)) {
          for (const options of OPTION_SETS) {
            const label = `${module.name} ${JSON.stringify(options)} ${JSON.stringify(text.slice(0, 60))}`
            expect(analyse(text, module, options, true), label).toEqual(analyse(text, module, options, false))
          }
        }
      })
    }
  },
)
