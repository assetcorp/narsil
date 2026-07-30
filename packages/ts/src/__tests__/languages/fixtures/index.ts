import { albanianFixture } from './albanian'
import { arabicFixture } from './arabic'
import { armenianFixture } from './armenian'
import { azerbaijaniFixture } from './azerbaijani'
import { basqueFixture } from './basque'
import { bretonFixture } from './breton'
import { bulgarianFixture } from './bulgarian'
import { catalanFixture } from './catalan'
import { chineseFixture } from './chinese'
import { croatianFixture } from './croatian'
import { czechFixture } from './czech'
import { dagbaniFixture } from './dagbani'
import { danishFixture } from './danish'
import { dutchFixture } from './dutch'
import { englishFixture } from './english'
import { esperantoFixture } from './esperanto'
import { estonianFixture } from './estonian'
import { eweFixture } from './ewe'
import { faroeseFixture } from './faroese'
import { finnishFixture } from './finnish'
import { frenchFixture } from './french'
import { gaFixture } from './ga'
import { galicianFixture } from './galician'
import { germanFixture } from './german'
import { greekFixture } from './greek'
import { haitianCreoleFixture } from './haitian-creole'
import { hausaFixture } from './hausa'
import { hindiFixture } from './hindi'
import { hungarianFixture } from './hungarian'
import { icelandicFixture } from './icelandic'
import { igboFixture } from './igbo'
import { indonesianFixture } from './indonesian'
import { irishFixture } from './irish'
import { italianFixture } from './italian'
import { japaneseFixture } from './japanese'
import { kurmanjiFixture } from './kurmanji'
import { kyrgyzFixture } from './kyrgyz'
import { latinFixture } from './latin'
import { latvianFixture } from './latvian'
import { lithuanianFixture } from './lithuanian'
import { luxembourgishFixture } from './luxembourgish'
import { macedonianFixture } from './macedonian'
import { malayFixture } from './malay'
import { nepaliFixture } from './nepali'
import { norwegianFixture } from './norwegian'
import { persianFixture } from './persian'
import { polishFixture } from './polish'
import { portugueseFixture } from './portuguese'
import { romanianFixture } from './romanian'
import { russianFixture } from './russian'
import { sanskritFixture } from './sanskrit'
import { scottishGaelicFixture } from './scottish-gaelic'
import { serbianFixture } from './serbian'
import { slovakFixture } from './slovak'
import { slovenianFixture } from './slovenian'
import { soraniFixture } from './sorani'
import { spanishFixture } from './spanish'
import { swahiliFixture } from './swahili'
import { swedishFixture } from './swedish'
import { tagalogFixture } from './tagalog'
import { tamilFixture } from './tamil'
import { tatarFixture } from './tatar'
import { turkishFixture } from './turkish'
import { twiFixture } from './twi'
import type { LanguageFixture } from './types'
import { ukrainianFixture } from './ukrainian'
import { urduFixture } from './urdu'
import { vietnameseFixture } from './vietnamese'
import { yorubaFixture } from './yoruba'
import { zuluFixture } from './zulu'

export type { LanguageFixture, ProseSample, RetrievalCase, SplitCase } from './types'

export const languageFixtures: readonly LanguageFixture[] = [
  albanianFixture,
  arabicFixture,
  armenianFixture,
  azerbaijaniFixture,
  basqueFixture,
  bretonFixture,
  bulgarianFixture,
  catalanFixture,
  chineseFixture,
  croatianFixture,
  czechFixture,
  dagbaniFixture,
  danishFixture,
  dutchFixture,
  englishFixture,
  esperantoFixture,
  estonianFixture,
  eweFixture,
  faroeseFixture,
  finnishFixture,
  frenchFixture,
  gaFixture,
  galicianFixture,
  germanFixture,
  greekFixture,
  haitianCreoleFixture,
  hausaFixture,
  hindiFixture,
  hungarianFixture,
  icelandicFixture,
  igboFixture,
  indonesianFixture,
  irishFixture,
  italianFixture,
  japaneseFixture,
  kurmanjiFixture,
  kyrgyzFixture,
  latinFixture,
  latvianFixture,
  lithuanianFixture,
  luxembourgishFixture,
  macedonianFixture,
  malayFixture,
  nepaliFixture,
  norwegianFixture,
  persianFixture,
  polishFixture,
  portugueseFixture,
  romanianFixture,
  russianFixture,
  sanskritFixture,
  scottishGaelicFixture,
  serbianFixture,
  slovakFixture,
  soraniFixture,
  slovenianFixture,
  spanishFixture,
  swahiliFixture,
  swedishFixture,
  tagalogFixture,
  tamilFixture,
  tatarFixture,
  turkishFixture,
  twiFixture,
  ukrainianFixture,
  urduFixture,
  vietnameseFixture,
  yorubaFixture,
  zuluFixture,
]

export const fixturesByLanguage: ReadonlyMap<string, LanguageFixture> = new Map(
  languageFixtures.map(fixture => [fixture.module.name, fixture]),
)
