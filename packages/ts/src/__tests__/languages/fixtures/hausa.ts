import { hausa } from '../../../languages/hausa'
import { defineLanguageFixture } from './types'

const HA_NIGERIA = "Hausa Wikipedia, article 'Najeriya' (data/processed/wikipedia/wikipedia-ha.json)"
const HA_KANO = "Hausa Wikipedia, article 'Kano (birni)' (data/processed/wikipedia/wikipedia-ha.json)"
const HA_CHAMELEON = "Hausa Wikipedia, article 'Hawainiya' (data/processed/wikipedia/wikipedia-ha.json)"
const HA_LANGUAGE = "Hausa Wikipedia, article 'Harshen Hausa' (data/processed/wikipedia/wikipedia-ha.json)"

export const hausaFixture = defineLanguageFixture({
  module: hausa,
  samples: [
    {
      text: "A shekara ta 1885 sai turawan Birtaniya suka mamaye duk fadin Nijeria har zuwa 01 ga oktoba 1960 Nijeriya ta samu 'yancin kanta daga turawan Biritaniya.",
      source: HA_NIGERIA,
    },
    {
      text: 'Ƙaramar yanki ce a cikin Afirka, matsakaiciyar ƙarfi a cikin al’amuran ƙasa da ƙasa, sannan kuma tana ɗaya daga cikin ƙasashe mafi yawan Al’umma a duniya.',
      source: HA_NIGERIA,
    },
    {
      text: 'Kano ita ce gari mafi yawan jama’a a Najeriya gaba ɗaya.',
      source: HA_KANO,
    },
    {
      text: 'A haka za ta mutu ta ruɓe, ƴaƴan cikin nata su ƙyanƙyashe sannan su fito duniya.',
      source: HA_CHAMELEON,
    },
    {
      text: 'Ana amfani da harafin ƴ (y mai lanƙwasa a dama) a Ƙasar Nijer Kawai, ana rubuta shi a ʼy a Najeriya.',
      source: HA_LANGUAGE,
    },
  ],
  indivisible: ["'yancin", "'yan", "jama'a", "al'amuran", "al'umma", 'ƙasashe', 'ɗaya', 'ruɓe', 'ƴaƴan', "'y"],
  separates: [
    {
      text: 'ta mutu ta ruɓe, ƴaƴan cikin nata',
      tokens: ['ta', 'mutu', 'ta', 'ruɓe', 'ƴaƴan', 'cikin', 'nata'],
    },
    { text: 'ana rubuta shi a ʼy a Najeriya', tokens: ['ana', 'rubuta', 'shi', 'a', "'y", 'a', 'najeriya'] },
    { text: "Nijeriya ta samu 'yancin kanta", tokens: ['nijeriya', 'ta', 'samu', "'yancin", 'kanta'] },
    { text: 'Kano ita ce gari mafi yawan jama’a', tokens: ['kano', 'ita', 'ce', 'gari', 'mafi', 'yawan', "jama'a"] },
  ],
  equivalent: [
    ["'yan", 'ʼyan'],
    ["jama'a", "jama'a"],
  ],
  retrievable: [
    {
      query: "'yancin",
      text: "A shekara ta 1885 sai turawan Birtaniya suka mamaye duk fadin Nijeria har zuwa 01 ga oktoba 1960 Nijeriya ta samu 'yancin kanta daga turawan Biritaniya.",
    },
    { query: "jama'a", text: 'Kano ita ce gari mafi yawan jama’a a Najeriya gaba ɗaya.' },
    {
      query: 'ƴaƴan',
      text: 'A haka za ta mutu ta ruɓe, ƴaƴan cikin nata su ƙyanƙyashe sannan su fito duniya.',
    },
  ],
})
