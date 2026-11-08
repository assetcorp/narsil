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
  'analysePacked',
  'transform',
] as const

const PACKED_COUNT_BYTES = Uint32Array.BYTES_PER_ELEMENT
const PACKED_RECORD_WORDS = 8

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

function packedUnitsOf(value: unknown): Uint16Array | number {
  if (typeof value === 'number') return value
  if (!(value instanceof ArrayBuffer) || value.byteLength < PACKED_COUNT_BYTES)
    throw new Error('The native search core returned an unexpected value from analysePacked.')
  const count = new Uint32Array(value, 0, 1)[0]
  const recordBytes = (1 + count * PACKED_RECORD_WORDS) * PACKED_COUNT_BYTES
  const unitBytes = value.byteLength - recordBytes
  if (unitBytes < 0 || unitBytes % Uint16Array.BYTES_PER_ELEMENT !== 0)
    throw new Error('The native search core returned an unexpected value from analysePacked.')
  return new Uint16Array(value, recordBytes, unitBytes / Uint16Array.BYTES_PER_ELEMENT)
}

export function adaptAnalysis(core: NarsilCore): NativeAnalysisCore {
  const languageCount = rawMethodOf(core, 'languageCount')
  const languageName = rawMethodOf(core, 'languageName')
  const languageRevision = rawMethodOf(core, 'languageRevision')
  const languageStopWords = rawMethodOf(core, 'languageStopWords')
  const createStopWordSet = rawMethodOf(core, 'createStopWordSet')
  const analyse = rawMethodOf(core, 'analyse')
  const analysePacked = rawMethodOf(core, 'analysePacked')
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
    analysePacked: (language, flags, text, stopWords) => packedUnitsOf(analysePacked(language, flags, text, stopWords)),
    transform(language, flags, token) {
      const result = transform(language, flags, token)
      if (typeof result === 'string' || typeof result === 'number') return result
      throw new Error('The native search core returned an unexpected value from transform.')
    },
  }
}
