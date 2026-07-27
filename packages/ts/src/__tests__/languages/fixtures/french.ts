import { french } from '../../../languages/french'
import { defineLanguageFixture } from './types'

const FR_ALGORITHM = "French Wikipedia, article 'Algorithmique' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_ARC = "French Wikipedia, article 'Arc de triomphe de l'Étoile' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_GIDE = "French Wikipedia, article 'André Gide' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_AGNOSTICISM = "French Wikipedia, article 'Agnosticisme' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_DENMARK = "French Wikipedia, article 'Danemark' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_CUISINE = "French Wikipedia, article 'Cuisine française' (data/processed/wikipedia/wikipedia-fr.json)"
const FR_PALINDROME = "French Wikipedia, article 'Palindrome' (data/processed/wikipedia/wikipedia-fr.json)"

export const frenchFixture = defineLanguageFixture({
  module: french,
  samples: [
    {
      text: "Les informaticiens utilisent fréquemment l’anglicisme implémentation pour désigner la mise en œuvre de l'algorithme dans un langage de programmation.",
      source: FR_ALGORITHM,
    },
    {
      text: 'Un algorithme énonce une solution à un problème sous la forme d’un enchaînement d’opérations à effectuer.',
      source: FR_ALGORITHM,
    },
    {
      text: "Il s'agit d'une œuvre posthume du couple d'artistes.",
      source: FR_ARC,
    },
    {
      text: 'Alors que naît avec Paul Valéry (qu’il rencontre par l’entremise de Pierre Louÿs) une amitié durable, ses relations avec Pierre Louÿs commencent à se détériorer.',
      source: FR_GIDE,
    },
    {
      text: "Les fêtes religieuses, comme Pâques, Noël, Yom Kippour, ou l'Aïd al-Adha, peuvent être tout aussi bien célébrées.",
      source: FR_AGNOSTICISM,
    },
    {
      text: "Ses nombreuses côtes littorales, ses plages ont permis le développement d'activités nautiques et aquatiques, où la pêche comme le canoë-kayak sont notamment populaires.",
      source: FR_DENMARK,
    },
    {
      text: 'Aussi, la bûche de Noël est une habitude bien française au moment de la période des fêtes.',
      source: FR_CUISINE,
    },
    {
      text: "Les palindromes (Palindrom) en allemand peuvent différencier les lettres ö de o, ü de u et ä de a, en négliger l'accentuation, ou encore les écrire sous leur forme archaïque oe, ue et ae.",
      source: FR_PALINDROME,
    },
  ],
  indivisible: [
    'œuvre',
    'cœur',
    'anglicisme',
    'enchaînement',
    'implémentation',
    'louÿs',
    'dufaÿs',
    'pâques',
    'noël',
    'canoë-kayak',
    'bûche',
    'où',
    'archaïque',
    'côtes',
  ],
  separates: [
    { text: "l'œuvre posthume", tokens: ['l', 'œuvre', 'posthume'] },
    { text: 'la mise en œuvre', tokens: ['la', 'mise', 'en', 'œuvre'] },
    { text: 'ex-æquo', tokens: ['ex-æquo'] },
    { text: 'Pierre Louÿs', tokens: ['pierre', 'louÿs'] },
    { text: 'où la pêche comme le canoë-kayak', tokens: ['où', 'la', 'pêche', 'comme', 'le', 'canoë-kayak'] },
    {
      text: 'la bûche de Noël est une habitude bien française',
      tokens: ['la', 'bûche', 'de', 'noël', 'est', 'une', 'habitude', 'bien', 'française'],
    },
    {
      text: 'les lettres ö de o, ü de u et ä de a',
      tokens: ['les', 'lettres', 'ö', 'de', 'o', 'ü', 'de', 'u', 'et', 'ä', 'de', 'a'],
    },
    { text: 'comme Pâques, Noël, Yom Kippour', tokens: ['comme', 'pâques', 'noël', 'yom', 'kippour'] },
  ],
  equivalent: [
    ["l'œuvre", 'l’œuvre'],
    ["d'une", 'd’une'],
  ],
  retrievable: [
    { query: 'œuvre', text: "Il s'agit d'une œuvre posthume du couple d'artistes." },
    {
      query: 'anglicisme',
      text: "Les informaticiens utilisent fréquemment l’anglicisme implémentation pour désigner la mise en œuvre de l'algorithme dans un langage de programmation.",
    },
    {
      query: 'canoë-kayak',
      text: "Ses nombreuses côtes littorales, ses plages ont permis le développement d'activités nautiques et aquatiques, où la pêche comme le canoë-kayak sont notamment populaires.",
    },
    {
      query: 'bûche',
      text: 'Aussi, la bûche de Noël est une habitude bien française au moment de la période des fêtes.',
    },
    {
      query: 'archaïque',
      text: "Les palindromes (Palindrom) en allemand peuvent différencier les lettres ö de o, ü de u et ä de a, en négliger l'accentuation, ou encore les écrire sous leur forme archaïque oe, ue et ae.",
    },
  ],
})
