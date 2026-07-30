import { dagbani } from '../../../languages/dagbani'
import { defineLanguageFixture } from './types'

const DAG_WIKIPEDIA =
  "Dagbani Wikipedia, article 'Abdul-Muthalib Hussein' (data/processed/wikipedia/wikipedia-dag.json)"
const DAG_UDHR =
  'Universal Declaration of Human Rights in Dagbani, United Nations OHCHR (NLTK udhr corpus, file Dagbani-UTF8)'
const DAG_ADIBO = "Dagbani Wikipedia, article 'Adibo Dalila' (data/processed/wikipedia/wikipedia-dag.json)"

export const dagbaniFixture = defineLanguageFixture({
  module: dagbani,
  samples: [
    {
      text: 'O ba yuli m-booni Hussein Masaka, ka o ma mi yuli booni Fatima.',
      source: DAG_WIKIPEDIA,
    },
    {
      text: 'Afa Mugtada n-nyɛ Limam zaŋ ti Zaapayim jiŋli din be Tamale sunsuuni la.',
      source: DAG_WIKIPEDIA,
    },
    {
      text: "Zal' shɛŋa din be litaafi ŋɔ ni lan nyɛla din tɔŋdi aminsi ni zɔsimdi ka bukaata kam maana.",
      source: DAG_UDHR,
    },
    {
      text: "Naa Andani II daa nyɛla zaɣ' pɔlli ka ʒini Yani gbandi zuɣu.",
      source: DAG_ADIBO,
    },
  ],
  indivisible: ['tamale', 'sunsuuni', 'zɔsimdi', 'litaafi', 'bukaata', 'ninvuɣ', 'tiŋgbani', 'ʒini'],
  separates: [
    { text: 'Afa Mugtada n-nyɛ Limam zaŋ ti', tokens: ['afa', 'mugtada', 'n', 'nyɛ', 'limam', 'zaŋ', 'ti'] },
    { text: "Zal' shɛŋa din be litaafi", tokens: ['zal', 'shɛŋa', 'din', 'be', 'litaafi'] },
    { text: 'ka ʒini Yani gbandi zuɣu', tokens: ['ka', 'ʒini', 'yani', 'gbandi', 'zuɣu'] },
  ],
  equivalent: [
    ['Tamale', 'tamale'],
    ["ninvuɣ'", 'ninvuɣ'],
    ['shɛli', 'shεli'],
    ['bɛ', 'bԑ'],
  ],
  retrievable: [
    { query: 'sunsuuni', text: 'Afa Mugtada n-nyɛ Limam zaŋ ti Zaapayim jiŋli din be Tamale sunsuuni la.' },
    {
      query: 'zɔsimdi',
      text: "Zal' shɛŋa din be litaafi ŋɔ ni lan nyɛla din tɔŋdi aminsi ni zɔsimdi ka bukaata kam maana.",
    },
    {
      query: 'ʒini',
      text: "Naa Andani II daa nyɛla zaɣ' pɔlli ka ʒini Yani gbandi zuɣu.",
    },
  ],
})
