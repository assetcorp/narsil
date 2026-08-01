import { georgian } from '../../../languages/georgian'
import { defineLanguageFixture } from './types'

const KA_LANGUAGE = "Georgian Wikipedia, article 'ქართული ენა' (https://ka.wikipedia.org/wiki/ქართული_ენა)"

export const georgianFixture = defineLanguageFixture({
  module: georgian,
  samples: [
    { text: 'ქართული ენა — ქართველურ ენათა ოჯახის ენა.', source: KA_LANGUAGE },
    { text: 'ქართველების მშობლიური ენა, საქართველოს სახელმწიფო ენა.', source: KA_LANGUAGE },
    { text: 'ქართულ ენაზე 5 მილიონზე მეტი ადამიანი ლაპარაკობს.', source: KA_LANGUAGE },
  ],
  indivisible: ['ქართული', 'მშობლიური', 'სახელმწიფო', 'ლაპარაკობს'],
  separates: [
    { text: 'ქართველების მშობლიური ენა', tokens: ['ქართველების', 'მშობლიური', 'ენა'] },
    { text: 'საქართველოს სახელმწიფო ენა', tokens: ['საქართველოს', 'სახელმწიფო', 'ენა'] },
  ],
  equivalent: [['ქართული', 'ქართული']],
  retrievable: [
    { query: 'ლაპარაკობს', text: 'ქართულ ენაზე 5 მილიონზე მეტი ადამიანი ლაპარაკობს.' },
    { query: 'სახელმწიფო', text: 'ქართველების მშობლიური ენა, საქართველოს სახელმწიფო ენა.' },
  ],
})
