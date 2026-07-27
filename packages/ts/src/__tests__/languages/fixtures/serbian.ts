import { serbian } from '../../../languages/serbian'
import { defineLanguageFixture } from './types'

const SR_CYRILLIC = "Serbian Wikipedia, article 'Српски језик' (https://sr.wikipedia.org/wiki/Српски_језик)"
const SR_LATIN =
  "Serbian Wikipedia, article 'Српски језик', Latin script variant (https://sr.wikipedia.org/sr-el/Српски_језик)"

export const serbianFixture = defineLanguageFixture({
  module: serbian,
  samples: [
    {
      text: 'За српски језик је карактеристична двоазбучност: српска ћирилица (приоритетно српско писмо) и српска латиница, коју су реформисали Вук Стефановић Караџић и Ђура Даничић.',
      source: SR_CYRILLIC,
    },
    {
      text: 'Za srpski jezik je karakteristična dvoazbučnost: srpska ćirilica (prioritetno srpsko pismo) i srpska latinica, koju su reformisali Vuk Stefanović Karadžić i Đura Daničić.',
      source: SR_LATIN,
    },
    {
      text: 'Srpski jezik je zvaničan u Srbiji, Bosni i Hercegovini i Crnoj Gori i govori ga oko 12 miliona ljudi.',
      source: SR_LATIN,
    },
  ],
  indivisible: ['karadžić', 'ćirilica', 'dvoazbučnost', 'đura', 'daničić', 'ћирилица', 'караџић'],
  separates: [
    {
      text: 'Vuk Stefanović Karadžić i Đura Daničić',
      tokens: ['vuk', 'stefanović', 'karadžić', 'i', 'đura', 'daničić'],
    },
    { text: 'srpska ćirilica i srpska latinica', tokens: ['srpska', 'ćirilica', 'i', 'srpska', 'latinica'] },
  ],
  equivalent: [
    ['ћирилица', 'ćirilica'],
    ['Караџић', 'Karadžić'],
  ],
  retrievable: [
    {
      query: 'karadžić',
      text: 'Za srpski jezik je karakteristična dvoazbučnost: srpska ćirilica (prioritetno srpsko pismo) i srpska latinica, koju su reformisali Vuk Stefanović Karadžić i Đura Daničić.',
    },
    {
      query: 'караџић',
      text: 'За српски језик је карактеристична двоазбучност: српска ћирилица (приоритетно српско писмо) и српска латиница, коју су реформисали Вук Стефановић Караџић и Ђура Даничић.',
    },
  ],
})
