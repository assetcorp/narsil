import { igbo } from '../../../languages/igbo'
import { defineLanguageFixture } from './types'

const IG_OWERRI = "Igbo Wikipedia, article 'Òwèrè' (data/processed/wikipedia/wikipedia-ig.json)"
const IG_ACHEBE = "Igbo Wikipedia, article 'Chinụa Achebe' (data/processed/wikipedia/wikipedia-ig.json)"
const IG_CHINEKE = "Igbo Wikipedia, article 'Chineke' (data/processed/wikipedia/wikipedia-ig.json)"
const IG_ABAKALIKI = "Igbo Wikipedia, article 'Abakaléké' (data/processed/wikipedia/wikipedia-ig.json)"
const IG_MUSODZA = "Igbo Wikipedia, article 'Masimba Musodza' (data/processed/wikipedia/wikipedia-ig.json)"

export const igboFixture = defineLanguageFixture({
  module: igbo,
  samples: [
    {
      text: 'Òwèrè (Owerri nà aka ede bèkeè) bụ ịsị óche Ȯra Imo (Imo State).',
      source: IG_OWERRI,
    },
    {
      text: 'Ọ mechara gakwaa mahadum nke Ibadan University of Ibadan, Ȯra Ọyọ (Oyo State) ebe ọ gụrụ asụsụ békè site n’afọ 1948 ruo afọ 1953.',
      source: IG_ACHEBE,
    },
    {
      text: "Chineke bụ aha ọzọ ndi Igbo n' omenala Igbo kpọrọ Chukwu.",
      source: IG_CHINEKE,
    },
    {
      text: 'Ha na-akwado ebe egwuregwu gọlfụ na ọtụtụ ụlọ oriri na ọṅụṅụ.',
      source: IG_ABAKALIKI,
    },
    {
      text: "O kwukwara na ọ bụ Ngũgĩ wa Thiong'o's Decolonising The Mind kpaliri ya.",
      source: IG_MUSODZA,
    },
  ],
  indivisible: ['òwèrè', 'óche', 'békè', 'ọtụtụ', 'ndị', 'asụsụ', 'kpọrọ', 'ọṅụṅụ', 'ngũgĩ'],
  separates: [
    { text: 'Òwèrè bụ ịsị óche', tokens: ['òwèrè', 'bụ', 'ịsị', 'óche'] },
    {
      text: 'Ọ mechara gakwaa mahadum nke Ibadan University of Ibadan',
      tokens: ['ọ', 'mechara', 'gakwaa', 'mahadum', 'nke', 'ibadan', 'university', 'of', 'ibadan'],
    },
    { text: 'ebe ọ gụrụ asụsụ békè', tokens: ['ebe', 'ọ', 'gụrụ', 'asụsụ', 'békè'] },
    { text: 'ụlọ oriri na ọṅụṅụ', tokens: ['ụlọ', 'oriri', 'na', 'ọṅụṅụ'] },
  ],
  equivalent: [['Òwèrè', 'òwèrè']],
  retrievable: [
    { query: 'òwèrè', text: 'Òwèrè (Owerri nà aka ede bèkeè) bụ ịsị óche Ȯra Imo (Imo State).' },
    { query: 'kpọrọ', text: "Chineke bụ aha ọzọ ndi Igbo n' omenala Igbo kpọrọ Chukwu." },
    { query: 'ọṅụṅụ', text: 'Ha na-akwado ebe egwuregwu gọlfụ na ọtụtụ ụlọ oriri na ọṅụṅụ.' },
  ],
})
