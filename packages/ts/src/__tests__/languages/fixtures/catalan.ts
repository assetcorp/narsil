import { catalan } from '../../../languages/catalan'
import { defineLanguageFixture } from './types'

const CA_LANGUAGE = "Catalan Wikipedia, article 'Català' (https://ca.wikipedia.org/wiki/Català)"

export const catalanFixture = defineLanguageFixture({
  module: catalan,
  samples: [
    {
      text: "El català o valencià és una llengua romànica parlada a Catalunya, el País Valencià, les Illes Balears, Andorra, la Franja de Ponent, la ciutat de l'Alguer, la Catalunya del Nord, el Carxe, i en comunitats arreu del món.",
      source: CA_LANGUAGE,
    },
    {
      text: "Com les altres llengües romàniques, el català prové del llatí vulgar que parlaven els romans que s'establiren a Hispània durant l'edat antiga.",
      source: CA_LANGUAGE,
    },
  ],
  indivisible: ['català', 'romànica', 'plaça', 'països', 'següent', 'llengües'],
  separates: [
    {
      text: 'el català prové del llatí vulgar',
      tokens: ['el', 'català', 'prové', 'del', 'llatí', 'vulgar'],
    },
    {
      text: "la ciutat de l'Alguer",
      tokens: ['la', 'ciutat', 'de', 'l', 'alguer'],
    },
  ],
  equivalent: [['Català', 'català']],
  retrievable: [
    {
      query: 'romànica',
      text: "El català o valencià és una llengua romànica parlada a Catalunya, el País Valencià, les Illes Balears, Andorra, la Franja de Ponent, la ciutat de l'Alguer, la Catalunya del Nord, el Carxe, i en comunitats arreu del món.",
    },
    {
      query: 'vulgar',
      text: "Com les altres llengües romàniques, el català prové del llatí vulgar que parlaven els romans que s'establiren a Hispània durant l'edat antiga.",
    },
  ],
})
