import { malay } from '../../../languages/malay'
import { defineLanguageFixture } from './types'

const MS_LANGUAGE = "Malay Wikipedia, article 'Bahasa Melayu' (https://ms.wikipedia.org/wiki/Bahasa_Melayu)"

export const malayFixture = defineLanguageFixture({
  module: malay,
  samples: [
    {
      text: 'Bahasa Melayu ialah salah satu daripada bahasa-bahasa Melayu-Polinesia di bawah keluarga bahasa Polinesia, yang merupakan bahasa rasmi di Malaysia, Brunei, Indonesia, dan Singapura, serta dituturkan di Timor Leste dan sebahagian wilayah di Kemboja, Filipina dan Thailand.',
      source: MS_LANGUAGE,
    },
    {
      text: 'Jumlah penutur bahasa ini mencakupi lebih daripada 290 juta penutur merentasi kawasan maritim Asia Tenggara.',
      source: MS_LANGUAGE,
    },
  ],
  indivisible: ['bahasa', 'penutur', 'dituturkan', 'merentasi'],
  separates: [
    {
      text: 'Jumlah penutur bahasa ini',
      tokens: ['jumlah', 'penutur', 'bahasa', 'ini'],
    },
    {
      text: 'kawasan maritim Asia Tenggara',
      tokens: ['kawasan', 'maritim', 'asia', 'tenggara'],
    },
  ],
  equivalent: [['Melayu', 'melayu']],
  retrievable: [
    {
      query: 'dituturkan',
      text: 'Bahasa Melayu ialah salah satu daripada bahasa-bahasa Melayu-Polinesia di bawah keluarga bahasa Polinesia, yang merupakan bahasa rasmi di Malaysia, Brunei, Indonesia, dan Singapura, serta dituturkan di Timor Leste dan sebahagian wilayah di Kemboja, Filipina dan Thailand.',
    },
    {
      query: 'merentasi',
      text: 'Jumlah penutur bahasa ini mencakupi lebih daripada 290 juta penutur merentasi kawasan maritim Asia Tenggara.',
    },
  ],
})
