import { vietnamese } from '../../../languages/vietnamese'
import { defineLanguageFixture } from './types'

const VI_LANGUAGE = "Vietnamese Wikipedia, article 'Tiếng Việt' (https://vi.wikipedia.org/wiki/Tiếng_Việt)"

export const vietnameseFixture = defineLanguageFixture({
  module: vietnamese,
  samples: [
    {
      text: 'Tiếng Việt, còn gọi là tiếng Kinh hay tiếng phổ thông, là một ngôn ngữ thuộc ngữ hệ Nam Á, được công nhận là ngôn ngữ chính thức tại Việt Nam.',
      source: VI_LANGUAGE,
    },
    {
      text: 'Đây là tiếng mẹ đẻ của khoảng 85% dân cư Việt Nam và một bộ phận đáng kể 5 triệu Việt kiều ở ngoại quốc, đồng thời là ngôn ngữ thứ hai của 53 dân tộc thiểu số được công nhận tại Việt Nam.',
      source: VI_LANGUAGE,
    },
  ],
  indivisible: ['tiếng', 'ngữ', 'việt', 'triệu', 'đồng'],
  separates: [
    {
      text: 'ngôn ngữ chính thức tại Việt Nam',
      tokens: ['ngôn', 'ngữ', 'chính', 'thức', 'tại', 'việt', 'nam'],
    },
    {
      text: 'tiếng mẹ đẻ',
      tokens: ['tiếng', 'mẹ', 'đẻ'],
    },
  ],
  equivalent: [
    ['Việt', 'việt'],
    ['Tiếng', 'tiếng'],
  ],
  retrievable: [
    {
      query: 'kinh',
      text: 'Tiếng Việt, còn gọi là tiếng Kinh hay tiếng phổ thông, là một ngôn ngữ thuộc ngữ hệ Nam Á, được công nhận là ngôn ngữ chính thức tại Việt Nam.',
    },
    {
      query: 'triệu',
      text: 'Đây là tiếng mẹ đẻ của khoảng 85% dân cư Việt Nam và một bộ phận đáng kể 5 triệu Việt kiều ở ngoại quốc, đồng thời là ngôn ngữ thứ hai của 53 dân tộc thiểu số được công nhận tại Việt Nam.',
    },
  ],
})
