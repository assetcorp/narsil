import { haitianCreole } from '../../../languages/haitian-creole'
import { defineLanguageFixture } from './types'

const HT_LANGUAGE = "Haitian Creole Wikipedia, article 'Kreyòl ayisyen' (https://ht.wikipedia.org/wiki/Kreyòl_ayisyen)"

export const haitianCreoleFixture = defineLanguageFixture({
  module: haitianCreole,
  samples: [
    {
      text: 'Kreyòl ayisyen, ou ayisyen, se lang kreyòl lan ki gen plis moun ki pale li sou latè kè nenpòt lòt lang kreyòl.',
      source: HT_LANGUAGE,
    },
    {
      text: 'Kreyòl ayisyen genyen yon òtograf ofisyèl depi 1980 e gen anpil ekriven ayisyen ki ekri liv enteresan sou diferan aspè esperyans ayisyen.',
      source: HT_LANGUAGE,
    },
  ],
  indivisible: ['kreyòl', 'ayisyen', 'òtograf', 'ofisyèl', 'latè'],
  separates: [
    {
      text: 'se lang kreyòl lan',
      tokens: ['se', 'lang', 'kreyòl', 'lan'],
    },
    {
      text: 'genyen yon òtograf ofisyèl',
      tokens: ['genyen', 'yon', 'òtograf', 'ofisyèl'],
    },
  ],
  equivalent: [['Kreyòl', 'kreyòl']],
  retrievable: [
    {
      query: 'latè',
      text: 'Kreyòl ayisyen, ou ayisyen, se lang kreyòl lan ki gen plis moun ki pale li sou latè kè nenpòt lòt lang kreyòl.',
    },
    {
      query: 'òtograf',
      text: 'Kreyòl ayisyen genyen yon òtograf ofisyèl depi 1980 e gen anpil ekriven ayisyen ki ekri liv enteresan sou diferan aspè esperyans ayisyen.',
    },
  ],
})
