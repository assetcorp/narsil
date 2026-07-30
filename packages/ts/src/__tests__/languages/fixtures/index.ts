import { arabicFixture } from './arabic'
import { armenianFixture } from './armenian'
import { bulgarianFixture } from './bulgarian'
import { chineseFixture } from './chinese'
import { dagbaniFixture } from './dagbani'
import { danishFixture } from './danish'
import { dutchFixture } from './dutch'
import { englishFixture } from './english'
import { eweFixture } from './ewe'
import { finnishFixture } from './finnish'
import { frenchFixture } from './french'
import { gaFixture } from './ga'
import { germanFixture } from './german'
import { greekFixture } from './greek'
import { hausaFixture } from './hausa'
import { hindiFixture } from './hindi'
import { hungarianFixture } from './hungarian'
import { igboFixture } from './igbo'
import { indonesianFixture } from './indonesian'
import { irishFixture } from './irish'
import { italianFixture } from './italian'
import { japaneseFixture } from './japanese'
import { nepaliFixture } from './nepali'
import { norwegianFixture } from './norwegian'
import { portugueseFixture } from './portuguese'
import { romanianFixture } from './romanian'
import { russianFixture } from './russian'
import { sanskritFixture } from './sanskrit'
import { serbianFixture } from './serbian'
import { slovenianFixture } from './slovenian'
import { spanishFixture } from './spanish'
import { swahiliFixture } from './swahili'
import { swedishFixture } from './swedish'
import { tamilFixture } from './tamil'
import { turkishFixture } from './turkish'
import { twiFixture } from './twi'
import type { LanguageFixture } from './types'
import { ukrainianFixture } from './ukrainian'
import { yorubaFixture } from './yoruba'
import { zuluFixture } from './zulu'

export type { LanguageFixture, ProseSample, RetrievalCase, SplitCase } from './types'

export const languageFixtures: readonly LanguageFixture[] = [
  arabicFixture,
  armenianFixture,
  bulgarianFixture,
  chineseFixture,
  dagbaniFixture,
  danishFixture,
  dutchFixture,
  englishFixture,
  eweFixture,
  finnishFixture,
  frenchFixture,
  gaFixture,
  germanFixture,
  greekFixture,
  hausaFixture,
  hindiFixture,
  hungarianFixture,
  igboFixture,
  indonesianFixture,
  irishFixture,
  italianFixture,
  japaneseFixture,
  nepaliFixture,
  norwegianFixture,
  portugueseFixture,
  romanianFixture,
  russianFixture,
  sanskritFixture,
  serbianFixture,
  slovenianFixture,
  spanishFixture,
  swahiliFixture,
  swedishFixture,
  tamilFixture,
  turkishFixture,
  twiFixture,
  ukrainianFixture,
  yorubaFixture,
  zuluFixture,
]

export const fixturesByLanguage: ReadonlyMap<string, LanguageFixture> = new Map(
  languageFixtures.map(fixture => [fixture.module.name, fixture]),
)
