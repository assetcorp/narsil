import { indonesian } from '../../../languages/indonesian'
import { defineLanguageFixture } from './types'

const ID_WIKIPEDIA = "Indonesian Wikipedia, article 'Bahasa Indonesia' (https://id.wikipedia.org/wiki/Bahasa_Indonesia)"

export const indonesianFixture = defineLanguageFixture({
  module: indonesian,
  samples: [
    {
      text: 'Bahasa Indonesia telah sejak lama digunakan sebagai basantara di wilayah kepulauan Indonesia yang rata-rata memiliki kemajemukan linguistika.',
      source: ID_WIKIPEDIA,
    },
    {
      text: 'Bahasa Indonesia memiliki banyak kata serapan yang berasal dari bahasa-bahasa Eropa, terutama dari bahasa Belanda, Portugis, Spanyol, dan Inggris.',
      source: ID_WIKIPEDIA,
    },
    {
      text: 'Dalam perkembangannya, bahasa ini mengalami perubahan akibat penggunaannya sebagai bahasa kerja di lingkungan administrasi kolonial dan berbagai proses pembakuan sejak awal abad ke-20.',
      source: ID_WIKIPEDIA,
    },
  ],
  indivisible: ['rata-rata', 'bahasa-bahasa', 'ke-20', 'kemajemukan', 'penggunaannya'],
  separates: [
    {
      text: 'Bahasa Indonesia memiliki banyak kata serapan',
      tokens: ['bahasa', 'indonesia', 'memiliki', 'banyak', 'kata', 'serapan'],
    },
    { text: 'yang rata-rata memiliki kemajemukan', tokens: ['yang', 'rata-rata', 'memiliki', 'kemajemukan'] },
  ],
  equivalent: [['Bahasa', 'bahasa']],
  retrievable: [
    {
      query: 'rata-rata',
      text: 'Bahasa Indonesia telah sejak lama digunakan sebagai basantara di wilayah kepulauan Indonesia yang rata-rata memiliki kemajemukan linguistika.',
    },
    {
      query: 'serapan',
      text: 'Bahasa Indonesia memiliki banyak kata serapan yang berasal dari bahasa-bahasa Eropa, terutama dari bahasa Belanda, Portugis, Spanyol, dan Inggris.',
    },
  ],
})
