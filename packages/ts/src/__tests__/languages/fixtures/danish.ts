import { danish } from '../../../languages/danish'
import { defineLanguageFixture } from './types'

const DA_LANGUAGE = "Danish Wikipedia, article 'Dansk (sprog)' (https://da.wikipedia.org/wiki/Dansk_(sprog))"
const DA_IDEA = "Danish Wikipedia, article 'Idé' (https://da.wikipedia.org/wiki/Idé)"

export const danishFixture = defineLanguageFixture({
  module: danish,
  samples: [
    {
      text: 'Dansk er et østnordisk sprog indenfor den germanske gren af den indoeuropæiske sprogfamilie.',
      source: DA_LANGUAGE,
    },
    {
      text: 'Dansk er tæt beslægtet med norsk, svensk og islandsk, og sproghistorisk har dansk været stærkt påvirket af nedertysk.',
      source: DA_LANGUAGE,
    },
    {
      text: 'En idé er en bevidst tanke om et konkret eller abstrakt problem.',
      source: DA_IDEA,
    },
    {
      text: 'Mennesket har en evne til at få idéer, som kan give anledning til koncepter eller tankegeneraliseringer, hvilket er grundlaget for al videnskab og filosofi.',
      source: DA_IDEA,
    },
  ],
  indivisible: ['idé', 'idéer', 'indoeuropæiske', 'påvirket', 'østnordisk', 'beslægtet'],
  separates: [
    { text: 'En idé er en bevidst tanke', tokens: ['en', 'ide', 'er', 'en', 'bevidst', 'tanke'] },
    {
      text: 'Dansk er et østnordisk sprog',
      tokens: ['dansk', 'er', 'et', 'østnordisk', 'sprog'],
    },
  ],
  equivalent: [
    ['idé', 'ide'],
    ['Dansk', 'dansk'],
  ],
  retrievable: [
    { query: 'idé', text: 'En idé er en bevidst tanke om et konkret eller abstrakt problem.' },
    {
      query: 'indoeuropæiske',
      text: 'Dansk er et østnordisk sprog indenfor den germanske gren af den indoeuropæiske sprogfamilie.',
    },
  ],
})
