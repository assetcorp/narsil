import { czech } from '../../../languages/czech'
import { defineLanguageFixture } from './types'

const CS_LANGUAGE = "Czech Wikipedia, article 'Čeština' (https://cs.wikipedia.org/wiki/Čeština)"

export const czechFixture = defineLanguageFixture({
  module: czech,
  samples: [
    {
      text: 'Čeština neboli český jazyk je západoslovanský jazyk, nejbližší slovenštině, poté lužické srbštině a polštině.',
      source: CS_LANGUAGE,
    },
    {
      text: 'Čeština se vyvinula ze západních nářečí praslovanštiny na konci 10. století.',
      source: CS_LANGUAGE,
    },
  ],
  indivisible: ['čeština', 'nejbližší', 'ďábel', 'kůň', 'šťastný', 'móda', 'únor'],
  separates: [
    {
      text: 'český jazyk je západoslovanský jazyk',
      tokens: ['český', 'jazyk', 'je', 'západoslovanský', 'jazyk'],
    },
    {
      text: 'Čeština se vyvinula ze západních nářečí',
      tokens: ['čeština', 'se', 'vyvinula', 'ze', 'západních', 'nářečí'],
    },
  ],
  equivalent: [['Čeština', 'čeština']],
  retrievable: [
    {
      query: 'západoslovanský',
      text: 'Čeština neboli český jazyk je západoslovanský jazyk, nejbližší slovenštině, poté lužické srbštině a polštině.',
    },
    {
      query: 'praslovanštiny',
      text: 'Čeština se vyvinula ze západních nářečí praslovanštiny na konci 10. století.',
    },
  ],
})
