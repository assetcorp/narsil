import { irish } from '../../../languages/irish'
import { defineLanguageFixture } from './types'

const GA_WIKIPEDIA = "Irish Wikipedia, article 'An Ghaeilge' (https://ga.wikipedia.org/wiki/An_Ghaeilge)"

export const irishFixture = defineLanguageFixture({
  module: irish,
  samples: [
    {
      text: 'Is í an teanga náisiúnta nó dhúchais agus an phríomhtheanga oifigiúil i bPoblacht na hÉireann í an Ghaeilge.',
      source: GA_WIKIPEDIA,
    },
    {
      text: "Ar an 13 Meitheamh 2005 d'aontaigh airí gnóthaí eachtracha an Aontais Eorpaigh glacadh leis an nGaeilge mar theanga oifigiúil oibre san AE.",
      source: GA_WIKIPEDIA,
    },
    {
      text: "Tabhair faoi deara gurb iondúil inniu a úsáidtear an leagan Muimhneach d'ainm na teanga, Gaelainn, le tagairt a dhéanamh do chanúint an chúige ina gcluinfeá an t-ainm seo uirthi.",
      source: GA_WIKIPEDIA,
    },
  ],
  indivisible: ["d'aontaigh", "d'ainm", 't-ainm', 'ngaeilge', 'héireann', 'bpoblacht', "b'fhéidir"],
  separates: [
    { text: 'i bPoblacht na hÉireann', tokens: ['i', 'bpoblacht', 'na', 'héireann'] },
    { text: 'an t-ainm seo uirthi', tokens: ['an', 't-ainm', 'seo', 'uirthi'] },
  ],
  equivalent: [
    ["d'aontaigh", 'd’aontaigh'],
    ['Ghaeilge', 'ghaeilge'],
  ],
  retrievable: [
    {
      query: "d'aontaigh",
      text: "Ar an 13 Meitheamh 2005 d'aontaigh airí gnóthaí eachtracha an Aontais Eorpaigh glacadh leis an nGaeilge mar theanga oifigiúil oibre san AE.",
    },
    {
      query: 'ghaeilge',
      text: 'Is í an teanga náisiúnta nó dhúchais agus an phríomhtheanga oifigiúil i bPoblacht na hÉireann í an Ghaeilge.',
    },
  ],
})
