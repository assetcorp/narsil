import { chinese } from '../../../languages/chinese'
import { defineLanguageFixture } from './types'

const ZH_WIKIPEDIA = "Chinese Wikipedia, article '汉语' (https://zh.wikipedia.org/wiki/汉语)"
const ZH_BIANG = "Chinese Wikipedia, article '𰻞𰻞麵' (https://zh.wikipedia.org/wiki/𰻞𰻞麵)"

export const chineseFixture = defineLanguageFixture({
  module: chinese,
  samples: [
    {
      text: '漢語又稱華語、中國語或中國話，是源自东亚的分析语，为汉民族的母语。',
      source: ZH_WIKIPEDIA,
    },
    {
      text: '中文是用汉字转录汉语的文本。',
      source: ZH_WIKIPEDIA,
    },
    {
      text: '在日常使用中，“中文”经常被视作是“汉语”的同义词，且在许多情况下是主流的表达方式。',
      source: ZH_WIKIPEDIA,
    },
    {
      text: '𰻞𰻞麵属于扯面，通过揉、抻、甩、扯等步骤制作，面條宽厚如裤腰带般，食用前多加入各色臊子或油泼辣子。',
      source: ZH_BIANG,
    },
  ],
  indivisible: ['汉语', '中文', '汉字', '母语'],
  separates: [
    {
      text: '中文是用汉字转录汉语的文本。',
      tokens: ['中文', '文是', '是用', '用汉', '汉字', '字转', '转录', '录汉', '汉语', '语的', '的文', '文本'],
    },
    { text: '漢語又稱華語', tokens: ['漢語', '語又', '又稱', '稱華', '華語'] },
    { text: '𰻞𰻞麵属于扯面', tokens: ['𰻞𰻞', '𰻞麵', '麵属', '属于', '于扯', '扯面'] },
  ],
  equivalent: [
    ['ＣＰＵ', 'CPU'],
    ['２０２４', '2024'],
  ],
  retrievable: [
    { query: '汉字', text: '中文是用汉字转录汉语的文本。' },
    {
      query: '同义词',
      text: '在日常使用中，“中文”经常被视作是“汉语”的同义词，且在许多情况下是主流的表达方式。',
    },
    { query: '母语', text: '漢語又稱華語、中國語或中國話，是源自东亚的分析语，为汉民族的母语。' },
    {
      query: '𰻞𰻞麵',
      text: '𰻞𰻞麵属于扯面，通过揉、抻、甩、扯等步骤制作，面條宽厚如裤腰带般，食用前多加入各色臊子或油泼辣子。',
    },
  ],
})
