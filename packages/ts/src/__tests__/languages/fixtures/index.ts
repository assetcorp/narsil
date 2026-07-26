import { eweFixture } from './ewe'
import type { LanguageFixture } from './types'

export type { LanguageFixture, ProseSample, RetrievalCase, SplitCase } from './types'

export const languageFixtures: readonly LanguageFixture[] = [eweFixture]

export const fixturesByLanguage: ReadonlyMap<string, LanguageFixture> = new Map(
  languageFixtures.map(fixture => [fixture.module.name, fixture]),
)
