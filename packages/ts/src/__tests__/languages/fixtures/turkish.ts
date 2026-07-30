import { turkish } from '../../../languages/turkish'
import { defineLanguageFixture } from './types'

const TR_ISTANBUL = "Turkish Wikipedia, article 'İstanbul' (https://tr.wikipedia.org/wiki/İstanbul)"
const TR_PAPER = "Turkish Wikipedia, article 'Kâğıt' (https://tr.wikipedia.org/wiki/Kâğıt)"

export const turkishFixture = defineLanguageFixture({
  module: turkish,
  samples: [
    {
      text: "İstanbul, Türkiye'nin ekonomik, kültürel ve tarihî merkezini oluşturan en kalabalık şehridir.",
      source: TR_ISTANBUL,
    },
    {
      text: 'İstanbul, iki kıtada yer alan bir şehir olup, nüfusunun yaklaşık üçte ikisi Avrupa yakasında, geri kalanı ise Asya yakasında yaşamaktadır.',
      source: TR_ISTANBUL,
    },
    {
      text: 'Kâğıt, çoğunlukla yazma işlemlerinde kullanılan, üzerine baskı ya da çizim yapılabilen veya ambalaj amacıyla kullanılan ince malzemedir.',
      source: TR_PAPER,
    },
    {
      text: 'Son yıllarda ortaya çıkarılan arkeolojik bulgularla, insanlık tarihine ilişkin önemli bilgiler elde edilmiştir.',
      source: TR_ISTANBUL,
    },
  ],
  indivisible: ['İstanbul', 'kâğıt', 'türkiye', 'şehridir', 'yaşamaktadır', 'kültürel', 'önemli', 'ortaya'],
  separates: [
    {
      text: 'İstanbul, iki kıtada yer alan bir şehir',
      tokens: ['istanbul', 'iki', 'kıtada', 'yer', 'alan', 'bir', 'şehir'],
    },
    {
      text: 'Kâğıt, çoğunlukla yazma işlemlerinde kullanılan',
      tokens: ['kâğıt', 'çoğunlukla', 'yazma', 'işlemlerinde', 'kullanılan'],
    },
    {
      text: 'insanlık tarihine ilişkin önemli bilgiler',
      tokens: ['insanlık', 'tarihine', 'ilişkin', 'önemli', 'bilgiler'],
    },
  ],
  equivalent: [
    ['İstanbul', 'istanbul'],
    ["Türkiye'nin", 'Türkiye’nin'],
  ],
  retrievable: [
    {
      query: 'istanbul',
      text: "İstanbul, Türkiye'nin ekonomik, kültürel ve tarihî merkezini oluşturan en kalabalık şehridir.",
    },
    {
      query: 'kâğıt',
      text: 'Kâğıt, çoğunlukla yazma işlemlerinde kullanılan, üzerine baskı ya da çizim yapılabilen veya ambalaj amacıyla kullanılan ince malzemedir.',
    },
    {
      query: 'önemli',
      text: 'Son yıllarda ortaya çıkarılan arkeolojik bulgularla, insanlık tarihine ilişkin önemli bilgiler elde edilmiştir.',
    },
  ],
})
