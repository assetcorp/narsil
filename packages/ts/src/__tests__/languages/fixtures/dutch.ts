import { dutch } from '../../../languages/dutch'
import { defineLanguageFixture } from './types'

const NL_LANGUAGE = "Dutch Wikipedia, article 'Nederlands' (https://nl.wikipedia.org/wiki/Nederlands)"
const NL_TREMA =
  "Dutch Wikipedia, article 'Trema in de Nederlandse spelling' (https://nl.wikipedia.org/wiki/Trema_in_de_Nederlandse_spelling)"
const NL_DIACRITIC = "Dutch Wikipedia, article 'Diakritisch teken' (https://nl.wikipedia.org/wiki/Diakritisch_teken)"
const NL_PINYIN = "Dutch Wikipedia, article 'Hanyu pinyin' (https://nl.wikipedia.org/wiki/Hanyu_pinyin)"
const NL_CATALAN = "Dutch Wikipedia, article 'Catalaans' (https://nl.wikipedia.org/wiki/Catalaans)"

export const dutchFixture = defineLanguageFixture({
  module: dutch,
  samples: [
    {
      text: 'Het Nederlands is een West-Germaanse taal, de meest gebruikte taal in Nederland en België, de officiële taal van Suriname.',
      source: NL_LANGUAGE,
    },
    {
      text: 'Voorbeelden: tetraëder, naïviteit, reële, Kanaän, coördinator, geïnd, reünie, conciërge, koloniën, poëzie, egoïsme, coördinatie, ruïne, vacuüm, Israël.',
      source: NL_TREMA,
    },
    {
      text: 'Het trema geeft aan dat de ermee gemarkeerde klinker het begin is van een nieuwe lettergreep.',
      source: NL_TREMA,
    },
    {
      text: 'Dit wordt in het Nederlands nogal eens gebruikt: vóórkomen versus voorkómen, alléén.',
      source: NL_DIACRITIC,
    },
    {
      text: 'Te herkennen, in het pinyin, aan het accent grave (à, è, ì, ò, ù) of aan het cijfer 4.',
      source: NL_PINYIN,
    },
    {
      text: 'In dat geval is het onderscheid namelijk wel duidelijk: halfgesloten é, ó en halfopen è, ò.',
      source: NL_CATALAN,
    },
  ],
  indivisible: [
    'coördinatie',
    'ruïne',
    'reünie',
    'naïviteit',
    'poëzie',
    'israël',
    'drieëndertig',
    'conciërge',
    'vacuüm',
    'vóórkomen',
    'voorkómen',
    'alléén',
  ],
  separates: [
    { text: 'coördinatie en ruïne', tokens: ['coördinatie', 'en', 'ruïne'] },
    { text: 'Het trema geeft aan', tokens: ['het', 'trema', 'geeft', 'aan'] },
    { text: 'vóórkomen versus voorkómen, alléén', tokens: ['vóórkomen', 'versus', 'voorkómen', 'alléén'] },
    {
      text: 'aan het accent grave (à, è, ì, ò, ù)',
      tokens: ['aan', 'het', 'accent', 'grave', 'à', 'è', 'ì', 'ò', 'ù'],
    },
    {
      text: 'halfgesloten é, ó en halfopen è, ò',
      tokens: ['halfgesloten', 'é', 'ó', 'en', 'halfopen', 'è', 'ò'],
    },
  ],
  equivalent: [['Nederlands', 'nederlands']],
  retrievable: [
    {
      query: 'coördinatie',
      text: 'Voorbeelden: tetraëder, naïviteit, reële, Kanaän, coördinator, geïnd, reünie, conciërge, koloniën, poëzie, egoïsme, coördinatie, ruïne, vacuüm, Israël.',
    },
    {
      query: 'trema',
      text: 'Het trema geeft aan dat de ermee gemarkeerde klinker het begin is van een nieuwe lettergreep.',
    },
    {
      query: 'vóórkomen',
      text: 'Dit wordt in het Nederlands nogal eens gebruikt: vóórkomen versus voorkómen, alléén.',
    },
  ],
})
