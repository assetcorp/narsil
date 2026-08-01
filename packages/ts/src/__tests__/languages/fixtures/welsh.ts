import { welsh } from '../../../languages/welsh'
import { defineLanguageFixture } from './types'

const CY_LANGUAGE = "Welsh Wikipedia, article 'Cymraeg' (https://cy.wikipedia.org/wiki/Cymraeg)"

export const welshFixture = defineLanguageFixture({
  module: welsh,
  samples: [
    {
      text: "Iaith Geltaidd a ddaeth o'r Frythoneg sy'n frodorol i'r Cymry yw Cymraeg.",
      source: CY_LANGUAGE,
    },
    {
      text: "Siaredir y Gymraeg fel iaith frodorol yng Nghymru gan tua 18% o'r boblogaeth, gan rai yn Lloegr, ac yn y Wladfa.",
      source: CY_LANGUAGE,
    },
  ],
  indivisible: ['cymraeg', 'frythoneg', 'boblogaeth', 'nghymru'],
  separates: [
    {
      text: "o'r Frythoneg",
      tokens: ['o', 'r', 'frythoneg'],
    },
    {
      text: "sy'n frodorol i'r Cymry",
      tokens: ['sy', 'n', 'frodorol', 'i', 'r', 'cymry'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'frythoneg',
      text: "Iaith Geltaidd a ddaeth o'r Frythoneg sy'n frodorol i'r Cymry yw Cymraeg.",
    },
    {
      query: 'boblogaeth',
      text: "Siaredir y Gymraeg fel iaith frodorol yng Nghymru gan tua 18% o'r boblogaeth, gan rai yn Lloegr, ac yn y Wladfa.",
    },
  ],
})
