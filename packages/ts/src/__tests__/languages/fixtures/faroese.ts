import { faroese } from '../../../languages/faroese'
import { defineLanguageFixture } from './types'

const FO_LANGUAGE = "Faroese Wikipedia, article 'Føroyskt mál' (https://fo.wikipedia.org/wiki/Føroyskt_mál)"

export const faroeseFixture = defineLanguageFixture({
  module: faroese,
  samples: [
    {
      text: 'Føroyskt er høvuðsmálið í Føroyum.',
      source: FO_LANGUAGE,
    },
    {
      text: 'Føroyskt mál hevur fýra føll og trý kyn, og grammatiski málbygningurin líkist ógvuliga nógv íslendskum, meðan orðatilfarið og í summum lutum úttalan líkist norska landsmálinum.',
      source: FO_LANGUAGE,
    },
  ],
  indivisible: ['føroyskt', 'høvuðsmálið', 'fýra', 'úttalan', 'málbygningurin'],
  separates: [
    {
      text: 'Føroyskt er høvuðsmálið í Føroyum',
      tokens: ['føroyskt', 'er', 'høvuðsmálið', 'í', 'føroyum'],
    },
    {
      text: 'hevur fýra føll og trý kyn',
      tokens: ['hevur', 'fýra', 'føll', 'og', 'trý', 'kyn'],
    },
  ],
  equivalent: [['Føroyskt', 'føroyskt']],
  retrievable: [
    {
      query: 'høvuðsmálið',
      text: 'Føroyskt er høvuðsmálið í Føroyum.',
    },
    {
      query: 'málbygningurin',
      text: 'Føroyskt mál hevur fýra føll og trý kyn, og grammatiski málbygningurin líkist ógvuliga nógv íslendskum, meðan orðatilfarið og í summum lutum úttalan líkist norska landsmálinum.',
    },
  ],
})
