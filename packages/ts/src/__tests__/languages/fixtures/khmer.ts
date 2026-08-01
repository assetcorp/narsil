import { khmer } from '../../../languages/khmer'
import { defineLanguageFixture } from './types'

const KM_LANGUAGE = "Khmer Wikipedia, article 'ភាសាខ្មែរ' (https://km.wikipedia.org/wiki/ភាសាខ្មែរ)"
const KM_COUNTRY = "Khmer Wikipedia, article 'ព្រះរាជាណាចក្រកម្ពុជា' (https://km.wikipedia.org/wiki/ព្រះរាជាណាចក្រកម្ពុជា)"

export const khmerFixture = defineLanguageFixture({
  module: khmer,
  samples: [
    {
      text: 'ភាសាខ្មែរ គឺជាភាសាកំណើតរបស់ជនជាតិខ្មែរនិងជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។',
      source: KM_LANGUAGE,
    },
    {
      text: 'ព្រះរាជាណាចក្រកម្ពុជា គឺជាប្រទេសមួយស្ថិតនៅផ្នែកខាងត្បូងនៃឧបទ្វីបឥណ្ឌូចិន',
      source: KM_COUNTRY,
    },
    {
      text: 'បើ​សរសេរ​តែ​រូប​វា​ដាច់​តែ​ឯង​នោះ នឹង​ពុំ​មាន​ន័យ​ប្រាកដ​ប្រជា​ថា​យ៉ាង​ណាៗ​នោះ​ឡើយ ។',
      source: KM_LANGUAGE,
    },
  ],
  indivisible: ['គឺ', 'នៅ', 'និង'],
  separates: [
    {
      text: 'ភាសាខ្មែរ',
      tokens: ['ភាសា', 'សាខ្', 'ខ្មែ', 'មែរ'],
    },
    {
      text: 'កម្ពុជា',
      tokens: ['កម្', 'ម្ពុ', 'ពុជា'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ភាសា',
      text: 'ភាសាខ្មែរ គឺជាភាសាកំណើតរបស់ជនជាតិខ្មែរនិងជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា។',
    },
    {
      query: 'ប្រទេស',
      text: 'ព្រះរាជាណាចក្រកម្ពុជា គឺជាប្រទេសមួយស្ថិតនៅផ្នែកខាងត្បូងនៃឧបទ្វីបឥណ្ឌូចិន',
    },
  ],
})
