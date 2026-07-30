import { romanian } from '../../../languages/romanian'
import { defineLanguageFixture } from './types'

const RO_LANGUAGE = "Romanian Wikipedia, article 'Limba română' (https://ro.wikipedia.org/wiki/Limba_română)"
const RO_LAW =
  'Parliament of the Republic of Moldova, Law No. 344 of 23 December 1994, published in Monitorul Oficial No. 3-4 art. 51 (https://ro.wikisource.org/wiki/LEGE_Nr._344_din_23-12-1994)'

export const romanianFixture = defineLanguageFixture({
  module: romanian,
  samples: [
    {
      text: 'În total, este vorbită de aproximativ 25 de milioane de persoane ca limbă maternă.',
      source: RO_LANGUAGE,
    },
    {
      text: 'Aceasta este utilizată în administrația publică, sistemul educațional și în mass-media.',
      source: RO_LANGUAGE,
    },
    {
      text: 'În Republica Moldova, limba română a fost recunoscută oficial prin Declarația de Independență din 1991.',
      source: RO_LANGUAGE,
    },
    {
      text: 'Universitatea din Cernăuți formează profesori pentru școlile românești în domenii precum filologia română, matematică și fizică.',
      source: RO_LANGUAGE,
    },
    {
      text: 'Călăuzindu-se de principiile Constituţiei Republicii Moldova;',
      source: RO_LAW,
    },
    {
      text: 'în scopul satisfacerii necesităţilor naţionale şi păstrării identităţii naţionale a găgăuzilor, dezvoltării lor plenare şi multilaterale, prosperării limbii şi culturii naţionale, asigurării sinestătorniciei politice şi economice;',
      source: RO_LAW,
    },
  ],
  indivisible: ['constituţiei', 'necesităţilor', 'naţionale', 'şi', 'educațional', 'și', 'română', 'românești'],
  separates: [
    {
      text: 'limba română a fost recunoscută oficial',
      tokens: ['limba', 'română', 'a', 'fost', 'recunoscută', 'oficial'],
    },
    {
      text: 'Călăuzindu-se de principiile Constituţiei Republicii Moldova;',
      tokens: ['călăuzindu', 'se', 'de', 'principiile', 'constituției', 'republicii', 'moldova'],
    },
    { text: 'limbii şi culturii naţionale', tokens: ['limbii', 'și', 'culturii', 'naționale'] },
  ],
  equivalent: [
    ['şi', 'și'],
    ['naţionale', 'naționale'],
  ],
  retrievable: [
    { query: 'constituţiei', text: 'Călăuzindu-se de principiile Constituţiei Republicii Moldova;' },
    {
      query: 'naționale',
      text: 'în scopul satisfacerii necesităţilor naţionale şi păstrării identităţii naţionale a găgăuzilor, dezvoltării lor plenare şi multilaterale, prosperării limbii şi culturii naţionale, asigurării sinestătorniciei politice şi economice;',
    },
    {
      query: 'română',
      text: 'În Republica Moldova, limba română a fost recunoscută oficial prin Declarația de Independență din 1991.',
    },
  ],
})
