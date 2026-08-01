import { burmese } from '../../../languages/burmese'
import { defineLanguageFixture } from './types'

const MY_LANGUAGE = "Burmese Wikipedia, article 'မြန်မာဘာသာစကား' (https://my.wikipedia.org/wiki/မြန်မာဘာသာစကား)"
const MY_COUNTRY = "Burmese Wikipedia, article 'မြန်မာနိုင်ငံ' (https://my.wikipedia.org/wiki/မြန်မာနိုင်ငံ)"

export const burmeseFixture = defineLanguageFixture({
  module: burmese,
  samples: [
    {
      text: 'မြန်မာဘာသာ သို့မဟုတ် ဗမာဘာသာ သည် မြန်မာနိုင်ငံ၏ တရားဝင် ရုံးသုံးဘာသာစကား ဖြစ်သည်။',
      source: MY_LANGUAGE,
    },
    {
      text: 'တရားဝင်အားဖြင့် ပြည်ထောင်စု သမ္မတ မြန်မာနိုင်ငံတော်',
      source: MY_COUNTRY,
    },
  ],
  indivisible: ['သည်', '၏'],
  separates: [
    {
      text: 'မြန်မာ',
      tokens: ['မြန်', 'န်မာ'],
    },
    {
      text: 'ဘာသာစကား',
      tokens: ['ဘာသာ', 'သာစ', 'စကား'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ဘာသာစကား',
      text: 'မြန်မာဘာသာ သို့မဟုတ် ဗမာဘာသာ သည် မြန်မာနိုင်ငံ၏ တရားဝင် ရုံးသုံးဘာသာစကား ဖြစ်သည်။',
    },
    {
      query: 'ပြည်ထောင်စု',
      text: 'တရားဝင်အားဖြင့် ပြည်ထောင်စု သမ္မတ မြန်မာနိုင်ငံတော်',
    },
  ],
})
