import { swedish } from '../../../languages/swedish'
import { defineLanguageFixture } from './types'

const SV_LANGUAGE = "Swedish Wikipedia, article 'Svenska' (https://sv.wikipedia.org/wiki/Svenska)"
const SV_CAFE = "Swedish Wikipedia, article 'Kafé' (https://sv.wikipedia.org/wiki/Kafé)"
const SV_MUESLI = "Swedish Wikipedia, article 'Müsli' (https://sv.wikipedia.org/wiki/Müsli)"

export const swedishFixture = defineLanguageFixture({
  module: swedish,
  samples: [
    {
      text: 'Svenska är nära besläktat och i hög grad ömsesidigt begripligt med danska och norska.',
      source: SV_LANGUAGE,
    },
    {
      text: 'Liksom de övriga nordiska språken härstammar svenskan från en gren av fornnordiska, vilket var det språk som talades av de germanska folken i Skandinavien.',
      source: SV_LANGUAGE,
    },
    {
      text: 'I övriga Finland talas det som modersmål framförallt i de finlandssvenska kustområdena i Österbotten, Åboland och Nyland.',
      source: SV_LANGUAGE,
    },
    {
      text: 'Ett kafé, café eller vardagligt fik är en inrättning som serverar kaffe (och ofta andra drycker) med kaffebröd eller annan lättare förtäring.',
      source: SV_CAFE,
    },
    {
      text: 'Müsli kan även användas vid bakning.',
      source: SV_MUESLI,
    },
    {
      text: 'Rostningen gör granola knaprigare än (annan) müsli.',
      source: SV_MUESLI,
    },
  ],
  indivisible: ['kafé', 'kaféet', 'kaféernas', 'besläktat', 'kustområdena', 'österbotten', 'müsli'],
  separates: [
    {
      text: 'Svenska är nära besläktat och i hög grad ömsesidigt begripligt',
      tokens: ['svenska', 'är', 'nära', 'besläktat', 'och', 'i', 'hög', 'grad', 'ömsesidigt', 'begripligt'],
    },
    { text: 'Österbotten, Åboland och Nyland', tokens: ['österbotten', 'åboland', 'och', 'nyland'] },
    { text: 'Ett kafé, café eller vardagligt fik', tokens: ['ett', 'kafé', 'café', 'eller', 'vardagligt', 'fik'] },
    {
      text: 'Müsli kan även användas vid bakning',
      tokens: ['müsli', 'kan', 'även', 'användas', 'vid', 'bakning'],
    },
  ],
  equivalent: [['Svenska', 'svenska']],
  retrievable: [
    {
      query: 'besläktat',
      text: 'Svenska är nära besläktat och i hög grad ömsesidigt begripligt med danska och norska.',
    },
    {
      query: 'kafé',
      text: 'Ett kafé, café eller vardagligt fik är en inrättning som serverar kaffe (och ofta andra drycker) med kaffebröd eller annan lättare förtäring.',
    },
    {
      query: 'müsli',
      text: 'Rostningen gör granola knaprigare än (annan) müsli.',
    },
  ],
})
