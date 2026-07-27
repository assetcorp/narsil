import { nepali } from '../../../languages/nepali'
import { defineLanguageFixture } from './types'

const NE_WIKIPEDIA = "Nepali Wikipedia, article 'नेपाली भाषा' (https://ne.wikipedia.org/wiki/नेपाली_भाषा)"

export const nepaliFixture = defineLanguageFixture({
  module: nepali,
  samples: [
    {
      text: 'नेपाली भाषा एक आर्य भाषा हो जुन दक्षिण एसियाको हिमालय क्षेत्रमा बोलिन्छ।',
      source: NE_WIKIPEDIA,
    },
    {
      text: 'नेपाली भाषा भुटानको लगभग एक चौथाई जनसङ्ख्या द्वारा बोलिन्छ।',
      source: NE_WIKIPEDIA,
    },
    {
      text: 'नेपाली लगभग १.६ करोड मातृभाषीहरू र अर्को ९ लाख मानिसले दोस्रो भाषाको रूपमा बोल्छन्।',
      source: NE_WIKIPEDIA,
    },
  ],
  indivisible: ['नेपाली', 'भाषा', 'बोलिन्छ', 'जनसङ्ख्या', 'मातृभाषीहरू'],
  separates: [
    {
      text: 'नेपाली भाषा भुटानको लगभग एक चौथाई जनसङ्ख्या द्वारा बोलिन्छ।',
      tokens: ['नेपाली', 'भाषा', 'भुटानको', 'लगभग', 'एक', 'चौथाई', 'जनसङ्ख्या', 'द्वारा', 'बोलिन्छ'],
    },
    { text: 'हिमालय क्षेत्रमा बोलिन्छ।', tokens: ['हिमालय', 'क्षेत्रमा', 'बोलिन्छ'] },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'बोलिन्छ',
      text: 'नेपाली भाषा एक आर्य भाषा हो जुन दक्षिण एसियाको हिमालय क्षेत्रमा बोलिन्छ।',
    },
    {
      query: 'मातृभाषीहरू',
      text: 'नेपाली लगभग १.६ करोड मातृभाषीहरू र अर्को ९ लाख मानिसले दोस्रो भाषाको रूपमा बोल्छन्।',
    },
  ],
})
