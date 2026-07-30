import { spanish } from '../../../languages/spanish'
import { defineLanguageFixture } from './types'

const ES_LANGUAGE = "Spanish Wikipedia, article 'Idioma español' (https://es.wikipedia.org/wiki/Idioma_español)"
const ES_DIAERESIS =
  "Spanish Wikipedia, article 'Diéresis', quoting José de Espronceda, El diablo mundo (https://es.wikipedia.org/wiki/Diéresis)"

export const spanishFixture = defineLanguageFixture({
  module: spanish,
  samples: [
    {
      text: 'El español o castellano es una lengua romance procedente del latín hablado, perteneciente a la familia de lenguas indoeuropeas.',
      source: ES_LANGUAGE,
    },
    {
      text: 'Tras la caída del Imperio romano, el latín vulgar de la Hispania romana se fue transformando y divergiendo de las otras variantes del latín que se hablaban en otras provincias del antiguo Imperio.',
      source: ES_LANGUAGE,
    },
    {
      text: '¡Cuán süave resonó en mi oído / el bullicio del mundo y su rüido!',
      source: ES_DIAERESIS,
    },
  ],
  indivisible: ['español', 'süave', 'rüido', 'lingüísticos', 'indoeuropeas', 'caída'],
  separates: [
    { text: '¡Cuán süave resonó en mi oído', tokens: ['cuán', 'süave', 'resonó', 'en', 'mi', 'oído'] },
    {
      text: 'El español o castellano es una lengua romance',
      tokens: ['el', 'español', 'o', 'castellano', 'es', 'una', 'lengua', 'romance'],
    },
  ],
  equivalent: [['Español', 'español']],
  retrievable: [
    { query: 'süave', text: '¡Cuán süave resonó en mi oído / el bullicio del mundo y su rüido!' },
    {
      query: 'castellano',
      text: 'El español o castellano es una lengua romance procedente del latín hablado, perteneciente a la familia de lenguas indoeuropeas.',
    },
  ],
})
