import { tibetan } from '../../../languages/tibetan'
import { defineLanguageFixture } from './types'

const BO_LANGUAGE = "Tibetan Wikipedia, article 'བོད་ཀྱི་སྐད་ཡིག།' (https://bo.wikipedia.org/wiki/བོད་ཀྱི་སྐད་ཡིག།)"

export const tibetanFixture = defineLanguageFixture({
  module: tibetan,
  samples: [
    {
      text: 'བོད་ཀྱི་སྐད་ཡིག་ནི་བོད་ཡུལ་དང་ཉེ་འཁོར་གྱི་ས་ཁུལ་བལ་ཡུལ།',
      source: BO_LANGUAGE,
    },
    {
      text: 'སྟོད་དབུས་གཙང་གི་སྐད་དང་། བར་ཁམས་པའི་སྐད་དང་། སྨད་ཨ་མདོའི་སྐད་རྣམས་སོ།',
      source: BO_LANGUAGE,
    },
  ],
  indivisible: ['བོད', 'སྐད', 'ཁམས', 'འཁོར'],
  separates: [
    {
      text: 'བོད་ཀྱི་སྐད་ཡིག',
      tokens: ['བོད', 'ཀྱི', 'སྐད', 'ཡིག'],
    },
    {
      text: 'སྨད་ཨ་མདོའི་སྐད་རྣམས་སོ',
      tokens: ['སྨད', 'ཨ', 'མདོའི', 'སྐད', 'རྣམས', 'སོ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'འཁོར',
      text: 'བོད་ཀྱི་སྐད་ཡིག་ནི་བོད་ཡུལ་དང་ཉེ་འཁོར་གྱི་ས་ཁུལ་བལ་ཡུལ།',
    },
    {
      query: 'ཁམས',
      text: 'སྟོད་དབུས་གཙང་གི་སྐད་དང་། བར་ཁམས་པའི་སྐད་དང་། སྨད་ཨ་མདོའི་སྐད་རྣམས་སོ།',
    },
  ],
})
