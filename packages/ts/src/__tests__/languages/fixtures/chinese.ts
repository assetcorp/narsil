import { chinese } from '../../../languages/chinese'
import { defineLanguageFixture } from './types'

const ZH_WIKIPEDIA = "Chinese Wikipedia, article '汉语' (https://zh.wikipedia.org/wiki/汉语)"

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
  ],
  indivisible: ['汉语', '中文', '汉字', '同义词', '母语'],
  separates: [
    { text: '中文是用汉字转录汉语的文本。', tokens: ['中文', '是', '用', '汉字', '转录', '汉语', '的', '文本'] },
    { text: '漢語又稱華語', tokens: ['漢語', '又', '稱', '華語'] },
  ],
  equivalent: [],
  retrievable: [
    { query: '汉字', text: '中文是用汉字转录汉语的文本。' },
    {
      query: '同义词',
      text: '在日常使用中，“中文”经常被视作是“汉语”的同义词，且在许多情况下是主流的表达方式。',
    },
  ],
})
