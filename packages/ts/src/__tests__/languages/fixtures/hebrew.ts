import { hebrew } from '../../../languages/hebrew'
import { defineLanguageFixture } from './types'

const HE_LANGUAGE = "Hebrew Wikipedia, article 'עברית' (https://he.wikipedia.org/wiki/עברית)"
const HE_GENESIS = 'Genesis 1:2, Masoretic text via Sefaria (https://www.sefaria.org/Genesis.1.2)'

export const hebrewFixture = defineLanguageFixture({
  module: hebrew,
  samples: [
    {
      text: 'עִבְרִית היא שפה שמית, ממשפחת השפות האפרו-אסייתיות, הידועה כשפתם של היהודים ושל השומרונים.',
      source: HE_LANGUAGE,
    },
    {
      text: 'וְהָאָ֗רֶץ הָיְתָ֥ה תֹ֙הוּ֙ וָבֹ֔הוּ וְחֹ֖שֶׁךְ עַל־פְּנֵ֣י תְה֑וֹם וְר֣וּחַ אֱלֹהִ֔ים מְרַחֶ֖פֶת עַל־פְּנֵ֥י הַמָּֽיִם׃',
      source: HE_GENESIS,
    },
    {
      text: 'העברית היא שפתה הרשמית של מדינת ישראל.',
      source: HE_LANGUAGE,
    },
  ],
  indivisible: ['עברית', 'ישראל', 'השומרונים', 'עֵ֚שֶׂב'],
  separates: [
    {
      text: 'עַל־פְּנֵ֣י תְה֑וֹם',
      tokens: ['על', 'פני', 'תהום'],
    },
    {
      text: 'שפתה הרשמית של מדינת ישראל',
      tokens: ['שפתה', 'הרשמית', 'של', 'מדינת', 'ישראל'],
    },
  ],
  equivalent: [
    ['עִבְרִית', 'עברית'],
    ['הַמָּֽיִם', 'המים'],
  ],
  retrievable: [
    {
      query: 'השומרונים',
      text: 'עִבְרִית היא שפה שמית, ממשפחת השפות האפרו-אסייתיות, הידועה כשפתם של היהודים ושל השומרונים.',
    },
    {
      query: 'תְה֑וֹם',
      text: 'וְהָאָ֗רֶץ הָיְתָ֥ה תֹ֙הוּ֙ וָבֹ֔הוּ וְחֹ֖שֶׁךְ עַל־פְּנֵ֣י תְה֑וֹם וְר֣וּחַ אֱלֹהִ֔ים מְרַחֶ֖פֶת עַל־פְּנֵ֥י הַמָּֽיִם׃',
    },
  ],
})
