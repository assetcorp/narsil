import { finnish } from '../../../languages/finnish'
import { defineLanguageFixture } from './types'

const FI_LANGUAGE = "Finnish Wikipedia, article 'Suomen kieli' (https://fi.wikipedia.org/wiki/Suomen_kieli)"
const FI_CZECHIA = "Finnish Wikipedia, article 'Tšekki' (https://fi.wikipedia.org/wiki/Tšekki)"

export const finnishFixture = defineLanguageFixture({
  module: finnish,
  samples: [
    {
      text: 'Suomen kieli eli suomi on uralilaisten kielten itämerensuomalaiseen ryhmään kuuluva kieli, jota puhuvat pääosin suomalaiset.',
      source: FI_LANGUAGE,
    },
    {
      text: 'Tšekin 10,9 miljoonasta asukkaasta suuren enemmistön muodostavat slaaveihin lukeutuvat tšekit.',
      source: FI_CZECHIA,
    },
    {
      text: 'Historiallisista Böömistä, Määristä ja Sleesian kaakkoisosasta muodostuva Tšekki on historiansa aikana ollut osa Habsburgien valtakuntaa sekä 1900-luvulla osa Tšekkoslovakiaa.',
      source: FI_CZECHIA,
    },
  ],
  indivisible: ['tšekki', 'tšekit', 'tšekkoslovakiaa', 'itämerensuomalaiseen', 'böömistä', 'määristä'],
  separates: [
    { text: 'Tšekin 10,9 miljoonasta asukkaasta', tokens: ['tšekin', '10', '9', 'miljoonasta', 'asukkaasta'] },
    { text: 'Suomen kieli eli suomi', tokens: ['suomen', 'kieli', 'eli', 'suomi'] },
  ],
  equivalent: [['Tšekki', 'tšekki']],
  retrievable: [
    {
      query: 'tšekit',
      text: 'Tšekin 10,9 miljoonasta asukkaasta suuren enemmistön muodostavat slaaveihin lukeutuvat tšekit.',
    },
    {
      query: 'suomalaiset',
      text: 'Suomen kieli eli suomi on uralilaisten kielten itämerensuomalaiseen ryhmään kuuluva kieli, jota puhuvat pääosin suomalaiset.',
    },
  ],
})
