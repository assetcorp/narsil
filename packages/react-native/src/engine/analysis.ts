import type { NativeAnalysisCore, NativeFoldingCore } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import { withNativeCode } from './native-error'

const ANALYSIS_METHODS = [
  'languageCount',
  'languageName',
  'languageRevision',
  'languageStopWords',
  'createStopWordSet',
  'analyse',
  'analysePacked',
  'transform',
  'foldSpelling',
  'createFoldTable',
] as const

type AnalysisMethod = (typeof ANALYSIS_METHODS)[number]

function rawMethodOf(core: NarsilCore, name: AnalysisMethod): (...parameters: unknown[]) => unknown {
  const method: unknown = Reflect.get(core, name)
  if (typeof method !== 'function') {
    return () => {
      throw new Error(`The native search core on this phone has no ${name} method, so it cannot analyse text.`)
    }
  }
  return (...parameters: unknown[]) => {
    try {
      return Reflect.apply(method, core, parameters)
    } catch (error) {
      throw withNativeCode(error)
    }
  }
}

function numberOf(value: unknown, name: AnalysisMethod): number {
  if (typeof value !== 'number') throw new Error(`The native search core returned no number from ${name}.`)
  return value
}

function textOf(value: unknown, name: AnalysisMethod): string {
  if (typeof value !== 'string') throw new Error(`The native search core returned no string from ${name}.`)
  return value
}

function textListOf(value: unknown, name: AnalysisMethod): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw new Error(`The native search core returned no list of strings from ${name}.`)
  }
  return value
}

function handleOf(value: unknown, name: AnalysisMethod): object {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`The native search core returned no handle from ${name}.`)
  }
  return value
}

function analysisResultOf(value: unknown, name: AnalysisMethod): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  throw new Error(`The native search core returned an unexpected value from ${name}.`)
}

function textOrStatusOf(value: unknown, name: AnalysisMethod): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new Error(`The native search core returned an unexpected value from ${name}.`)
}

function packedResultOf(value: unknown): number | null {
  if (value === null || typeof value === 'number') return value
  throw new Error('The native search core returned an unexpected value from analysePacked.')
}

export function adaptAnalysis(
  core: NarsilCore,
): NativeAnalysisCore & Pick<NativeFoldingCore, 'foldSpelling' | 'createFoldTable'> {
  const languageCount = rawMethodOf(core, 'languageCount')
  const languageName = rawMethodOf(core, 'languageName')
  const languageRevision = rawMethodOf(core, 'languageRevision')
  const languageStopWords = rawMethodOf(core, 'languageStopWords')
  const createStopWordSet = rawMethodOf(core, 'createStopWordSet')
  const analyse = rawMethodOf(core, 'analyse')
  const analysePacked = rawMethodOf(core, 'analysePacked')
  const transform = rawMethodOf(core, 'transform')
  const foldSpelling = rawMethodOf(core, 'foldSpelling')
  const createFoldTable = rawMethodOf(core, 'createFoldTable')
  return {
    languageCount: () => numberOf(languageCount(), 'languageCount'),
    languageName: language => textOf(languageName(language), 'languageName'),
    languageRevision: language => textOf(languageRevision(language), 'languageRevision'),
    languageStopWords: language => textListOf(languageStopWords(language), 'languageStopWords'),
    createStopWordSet: words => handleOf(createStopWordSet(words), 'createStopWordSet'),
    analyse: (language, flags, text, stopWords, records) =>
      analysisResultOf(
        analyse(language, flags, text, stopWords, records.buffer, records.byteOffset, records.length),
        'analyse',
      ),
    analysePacked: (language, flags, text, stopWords, records, units) =>
      packedResultOf(
        analysePacked(
          language,
          flags,
          text,
          stopWords,
          records.buffer,
          records.byteOffset,
          records.length,
          units.buffer,
          units.byteOffset,
          units.length,
        ),
      ),
    transform: (language, flags, token) => textOrStatusOf(transform(language, flags, token), 'transform'),
    foldSpelling: (language, flags, spelling) =>
      textOrStatusOf(foldSpelling(language, flags, spelling), 'foldSpelling'),
    createFoldTable: () => handleOf(createFoldTable(), 'createFoldTable'),
  }
}
