import { norwegian } from '../../../languages/norwegian'
import { defineLanguageFixture } from './types'

const NO_LANGUAGE = "Norwegian Wikipedia, article 'Norsk' (https://no.wikipedia.org/wiki/Norsk)"
const NO_ACUTE = "Norwegian Wikipedia, article 'Akutt aksent' (https://no.wikipedia.org/wiki/Akutt_aksent)"
const NO_GERMAN = "Norwegian Wikipedia, article 'Tysk' (https://no.wikipedia.org/wiki/Tysk)"

export const norwegianFixture = defineLanguageFixture({
  module: norwegian,
  samples: [
    {
      text: 'Norsk er et nordisk språk som, sammen med samisk, er et av Norges offisielle språk og morsmål til rundt 90 prosent av befolkningen i Norge.',
      source: NO_LANGUAGE,
    },
    {
      text: 'Norsk, svensk og dansk utgjør sammen de fastlandsnordiske språkene, et kontinuum av mer eller mindre innbyrdes forståelige dialekter i Skandinavia.',
      source: NO_LANGUAGE,
    },
    {
      text: 'allé, diaré, kafé, idé, entré, komité, kupé, moské, supé, trofé, diskré, trasé, én (tallord) fór (preteritum av å fare i nynorsk), blót.',
      source: NO_ACUTE,
    },
    {
      text: 'Det bygger på det latinske alfabetet og har i tillegg de tre vokalene æ, ø og å, som har sin plass i slutten av alfabetet.',
      source: NO_LANGUAGE,
    },
    {
      text: 'Før andre verdenskrig bodde det 3 millioner tysktalende i Böhmen og Mähren.',
      source: NO_GERMAN,
    },
    {
      text: 'Også språket i byer som Hamburg, Kiel og Münster regnes ofte som «fint».',
      source: NO_GERMAN,
    },
  ],
  indivisible: [
    'allé',
    'kafé',
    'idé',
    'komité',
    'én',
    'fór',
    'blót',
    'moské',
    'vokalene',
    'böhmen',
    'mähren',
    'münster',
  ],
  separates: [
    { text: 'allé, diaré, kafé, idé', tokens: ['allé', 'diaré', 'kafé', 'idé'] },
    { text: 'Norsk, svensk og dansk', tokens: ['norsk', 'svensk', 'og', 'dansk'] },
    { text: 'de tre vokalene æ, ø og å', tokens: ['de', 'tre', 'vokalene', 'æ', 'ø', 'og', 'å'] },
    { text: 'tysktalende i Böhmen og Mähren', tokens: ['tysktalende', 'i', 'böhmen', 'og', 'mähren'] },
    { text: 'byer som Hamburg, Kiel og Münster', tokens: ['byer', 'som', 'hamburg', 'kiel', 'og', 'münster'] },
  ],
  equivalent: [['Norsk', 'norsk']],
  retrievable: [
    {
      query: 'kafé',
      text: 'allé, diaré, kafé, idé, entré, komité, kupé, moské, supé, trofé, diskré, trasé, én (tallord) fór (preteritum av å fare i nynorsk), blót.',
    },
    {
      query: 'språk',
      text: 'Norsk er et nordisk språk som, sammen med samisk, er et av Norges offisielle språk og morsmål til rundt 90 prosent av befolkningen i Norge.',
    },
    {
      query: 'mähren',
      text: 'Før andre verdenskrig bodde det 3 millioner tysktalende i Böhmen og Mähren.',
    },
    {
      query: 'münster',
      text: 'Også språket i byer som Hamburg, Kiel og Münster regnes ofte som «fint».',
    },
  ],
})
