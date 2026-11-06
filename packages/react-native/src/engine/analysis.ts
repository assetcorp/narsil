import type { NativeAnalysisCore, NativeStopWordSetHandle } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import { withNativeCode } from './native-error'

const ANALYSIS_METHODS = [
  'languageCount',
  'languageName',
  'languageRevision',
  'languageStopWords',
  'createStopWordSet',
  'analyse',
  'transform',
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

function handleOf(value: unknown): NativeStopWordSetHandle {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The native search core returned no stop word set from createStopWordSet.')
  }
  return value
}

function analysisResultOf(value: unknown, name: AnalysisMethod): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  throw new Error(`The native search core returned an unexpected value from ${name}.`)
}

export function adaptAnalysis(core: NarsilCore): NativeAnalysisCore {
  const languageCount = rawMethodOf(core, 'languageCount')
  const languageName = rawMethodOf(core, 'languageName')
  const languageRevision = rawMethodOf(core, 'languageRevision')
  const languageStopWords = rawMethodOf(core, 'languageStopWords')
  const createStopWordSet = rawMethodOf(core, 'createStopWordSet')
  const analyse = rawMethodOf(core, 'analyse')
  const transform = rawMethodOf(core, 'transform')
  return {
    languageCount: () => numberOf(languageCount(), 'languageCount'),
    languageName: language => textOf(languageName(language), 'languageName'),
    languageRevision: language => textOf(languageRevision(language), 'languageRevision'),
    languageStopWords: language => textListOf(languageStopWords(language), 'languageStopWords'),
    createStopWordSet: words => handleOf(createStopWordSet(words)),
    analyse: (language, flags, text, stopWords, records) =>
      analysisResultOf(
        analyse(language, flags, text, stopWords, records.buffer, records.byteOffset, records.length),
        'analyse',
      ),
    transform(language, flags, token) {
      const result = transform(language, flags, token)
      if (typeof result === 'string' || typeof result === 'number') return result
      throw new Error('The native search core returned an unexpected value from transform.')
    },
  }
}
