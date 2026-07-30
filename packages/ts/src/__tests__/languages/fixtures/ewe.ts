import { ewe } from '../../../languages/ewe'
import { defineLanguageFixture } from './types'

const EE_INTERLINGUE = "Ewe Wikipedia, article 'Interlinguegbe' (data/processed/wikipedia/wikipedia-ee.json)"
const EE_JESUS = "Ewe Wikipedia, article 'Yesu' (data/processed/wikipedia/wikipedia-ee.json)"
const EE_WITNESSES = "Ewe Wikipedia, article 'Yehowa Ðasefowo' (data/processed/wikipedia/wikipedia-ee.json)"
const EE_CHURCH = "Ewe Wikipedia, article 'Yesu Hame Vavã' (data/processed/wikipedia/wikipedia-ee.json)"
const EE_PANAMA = "Ewe Wikipedia, article 'Panama' (data/processed/wikipedia/wikipedia-ee.json)"
const EE_OSHOFFA = "Ewe Wikipedia, article 'Emmanuel Oshoffa' (data/processed/wikipedia/wikipedia-ee.json)"

export const eweFixture = defineLanguageFixture({
  module: ewe,
  samples: [
    {
      text: 'Eʋenyigba de lolo ge abe Asãte kple Dahome, siwo le eƒe goawo kple eve dzi, ene.',
      source: "Ewe Wikipedia, article 'Eʋegbe' (data/processed/wikipedia/wikipedia-ee.json)",
    },
    {
      text: 'Ephraim Kɔku Amu nye Ghana hakpalawo ta tɔ ɖeka kpakple nufiala.',
      source: "Ewe Wikipedia, article 'Ephraim Amu' (data/processed/wikipedia/wikipedia-ee.json)",
    },
    {
      text: 'Akowo ɖua nukuwo, seƒoƒowo kple nutsetsewo.',
      source: "Ewe Wikipedia, article 'Ako' (data/processed/wikipedia/wikipedia-ee.json)",
    },
    {
      text: 'Woŋlɔa gbeɖiɖi ƒe gbeɖiɖiwo ɖe ablɔɖegbeɖiɖi atɔ̃awo dzi tsɔ fiaa nuteɖeamedzi si mesɔ o, eye gbeɖiɖi sesẽ (á é í ó ú) ye nyo wu, gake woɖe mɔ ɖe bubuwo (è, ê, kple bubuawo) ŋu.',
      source: EE_INTERLINGUE,
    },
    {
      text: 'Àtrɔ ava àdrɔnʋɔnu amegbetɔwo katã ne fofoa ɖemɔ ne be woawɔ esia.',
      source: EE_JESUS,
    },
    {
      text: 'Wo lɔ̃ bena Yesu yi dziƒo eye wo le mɔkpɔm be aga trɔ ava ne xexeame yɔ fũ kple eƒe nuvɔ̃wo.',
      source: EE_JESUS,
    },
    {
      text: 'Alo ɖewohĩ èƒo nu kpli wo kpuie le wò ʋɔtru nu kpɔ.',
      source: EE_WITNESSES,
    },
    {
      text: 'Tó eyamee miexɔna Aƒetɔla ƒe ŋutilã kple Ʋù be miawɔɖeka kplii, be miakpɔ agbemavɔ, eye miafɔ le ŋkeke mamlea dzi.',
      source: EE_CHURCH,
    },
    {
      text: 'Ɖewohì nu si wonya na Panama nyuie nye eƒe tsimɔ si tso Atlantik va do ɖe Pasifik atsiaƒu gã la me.',
      source: EE_PANAMA,
    },
    {
      text: 'Eyata enɔ nɔnɔme me be wòagblɔ nyagblɔɖila la ƒe ɣeyiɣi mamlɛawo ŋuti nuŋlɔɖi aɖewo.',
      source: EE_OSHOFFA,
    },
  ],
  indivisible: [
    'eʋegbe',
    'eʋe',
    'eƒe',
    'seƒoƒowo',
    'aʋa',
    'ɖeka',
    'kɔku',
    'asãte',
    'ɖewohĩ',
    'ɖewohì',
    'ɣeyiɣi',
    'mamlɛawo',
    'fũ',
    'àtrɔ',
    'nuteɖeamedzi',
  ],
  separates: [
    { text: 'eʋegbe kple eƒe', tokens: ['eʋegbe', 'kple', 'eƒe'] },
    { text: 'Gana ƒe fiadzue nye Accra.', tokens: ['gana', 'ƒe', 'fiadzue', 'nye', 'accra'] },
    { text: 'ɣeyiɣi mamlɛawo ŋuti', tokens: ['ɣeyiɣi', 'mamlɛawo', 'ŋuti'] },
    { text: 'gbeɖiɖi sesẽ (á é í ó ú)', tokens: ['gbeɖiɖi', 'sesẽ', 'á', 'é', 'í', 'ó', 'ú'] },
  ],
  equivalent: [
    ['ɖeka', 'ðeka'],
    ['Eʋegbe', 'eʋegbe'],
  ],
  retrievable: [
    { query: 'eʋegbe', text: 'Eʋegbe nye gbe si wodona le Ghana kple Togo.' },
    { query: 'seƒoƒowo', text: 'Akowo ɖua nukuwo, seƒoƒowo kple nutsetsewo.' },
    {
      query: 'ɣeyiɣi',
      text: 'Eyata enɔ nɔnɔme me be wòagblɔ nyagblɔɖila la ƒe ɣeyiɣi mamlɛawo ŋuti nuŋlɔɖi aɖewo.',
    },
    {
      query: 'ɖewohĩ',
      text: 'Alo ɖewohĩ èƒo nu kpli wo kpuie le wò ʋɔtru nu kpɔ.',
    },
  ],
})
