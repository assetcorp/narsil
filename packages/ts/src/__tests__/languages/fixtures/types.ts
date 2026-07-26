import type { LanguageModule } from '../../../types/language'

export interface ProseSample {
  text: string
  source: string
}

export interface SplitCase {
  text: string
  tokens: string[]
}

export interface RetrievalCase {
  query: string
  text: string
}

export interface LanguageFixture {
  module: LanguageModule
  samples: ProseSample[]
  indivisible: string[]
  separates: SplitCase[]
  equivalent: Array<[string, string]>
  retrievable: RetrievalCase[]
}

export function defineLanguageFixture(fixture: LanguageFixture): LanguageFixture {
  return fixture
}
