import { sinhala } from '../../../languages/sinhala'
import { defineLanguageFixture } from './types'

const SI_LANGUAGE = "Sinhala Wikipedia, article 'සිංහල බස' (https://si.wikipedia.org/wiki/සිංහල_බස)"

export const sinhalaFixture = defineLanguageFixture({
  module: sinhala,
  samples: [
    {
      text: 'ශ්‍රී ලංකාවේ ප්‍රධාන ජාතිය වන සිංහල ජනයාගේ මව් බස සිංහල වෙයි.',
      source: SI_LANGUAGE,
    },
    {
      text: 'සිංහල ශ්‍රී ලංකාවේ නිල භාෂාවයි.',
      source: SI_LANGUAGE,
    },
  ],
  indivisible: ['සිංහල', 'ලංකාවේ', 'ජනයාගේ', 'ශ්‍රී'],
  separates: [
    {
      text: 'සිංහල ශ්‍රී ලංකාවේ නිල භාෂාවයි',
      tokens: ['සිංහල', 'ශ්රී', 'ලංකාවේ', 'නිල', 'භාෂාවයි'],
    },
    {
      text: 'සිංහල ජනයාගේ මව් බස',
      tokens: ['සිංහල', 'ජනයාගේ', 'මව්', 'බස'],
    },
  ],
  equivalent: [['ශ්‍රී', 'ශ්රී']],
  retrievable: [
    {
      query: 'ජනයාගේ',
      text: 'ශ්‍රී ලංකාවේ ප්‍රධාන ජාතිය වන සිංහල ජනයාගේ මව් බස සිංහල වෙයි.',
    },
    {
      query: 'භාෂාවයි',
      text: 'සිංහල ශ්‍රී ලංකාවේ නිල භාෂාවයි.',
    },
  ],
})
