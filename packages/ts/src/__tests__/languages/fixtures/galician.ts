import { galician } from '../../../languages/galician'
import { defineLanguageFixture } from './types'

const GL_LANGUAGE = "Galician Wikipedia, article 'Lingua galega' (https://gl.wikipedia.org/wiki/Lingua_galega)"

export const galicianFixture = defineLanguageFixture({
  module: galician,
  samples: [
    {
      text: 'É a lingua propia de Galicia, onde é falada por uns 2,4 millóns de galegos.',
      source: GL_LANGUAGE,
    },
    {
      text: 'Á parte de en Galicia, a lingua fálase tamén en territorios limítrofes con esta comunidade, aínda que sen estatuto de oficialidade, así como pola diáspora galega que emigrou a outras partes de España, a América Latina, os Estados Unidos, Suíza e outros países de Europa.',
      source: GL_LANGUAGE,
    },
  ],
  indivisible: ['millóns', 'fálase', 'lingüística', 'diáspora', 'limítrofes'],
  separates: [
    {
      text: 'a lingua propia de Galicia',
      tokens: ['a', 'lingua', 'propia', 'de', 'galicia'],
    },
    {
      text: 'pola diáspora galega que emigrou',
      tokens: ['pola', 'diáspora', 'galega', 'que', 'emigrou'],
    },
  ],
  equivalent: [['Galicia', 'galicia']],
  retrievable: [
    {
      query: 'millóns',
      text: 'É a lingua propia de Galicia, onde é falada por uns 2,4 millóns de galegos.',
    },
    {
      query: 'diáspora',
      text: 'Á parte de en Galicia, a lingua fálase tamén en territorios limítrofes con esta comunidade, aínda que sen estatuto de oficialidade, así como pola diáspora galega que emigrou a outras partes de España, a América Latina, os Estados Unidos, Suíza e outros países de Europa.',
    },
  ],
})
