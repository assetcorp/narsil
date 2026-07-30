import { tagalog } from '../../../languages/tagalog'
import { defineLanguageFixture } from './types'

const TL_LANGUAGE = "Tagalog Wikipedia, article 'Wikang Tagalog' (https://tl.wikipedia.org/wiki/Wikang_Tagalog)"

export const tagalogFixture = defineLanguageFixture({
  module: tagalog,
  samples: [
    {
      text: 'Ang wikang Tagalog, o ang Tagalog, ay isa sa mga pinakagamit na wika sa Pilipinas.',
      source: TL_LANGUAGE,
    },
    {
      text: 'Ito ang nangingibabaw na katutubong wika sa mga lalawigan ng Cavite, Laguna, Batangas, Rizal, Quezon o ang CALABARZON, sa lalawigan ng Marinduque at sa pulo ng Mindoro, sa Bulacan, sa Nueva Ecija, Aurora, Bataan, sa bayang Paracale sa lalawigan ng Camarines Norte, at sa Kalakhang Maynila.',
      source: TL_LANGUAGE,
    },
  ],
  indivisible: ['wikang', 'pinakagamit', 'nangingibabaw', 'katutubong'],
  separates: [
    {
      text: 'isa sa mga pinakagamit na wika sa Pilipinas',
      tokens: ['isa', 'sa', 'mga', 'pinakagamit', 'na', 'wika', 'sa', 'pilipinas'],
    },
    {
      text: 'katutubong wika sa mga lalawigan',
      tokens: ['katutubong', 'wika', 'sa', 'mga', 'lalawigan'],
    },
  ],
  equivalent: [['Tagalog', 'tagalog']],
  retrievable: [
    {
      query: 'pinakagamit',
      text: 'Ang wikang Tagalog, o ang Tagalog, ay isa sa mga pinakagamit na wika sa Pilipinas.',
    },
    {
      query: 'nangingibabaw',
      text: 'Ito ang nangingibabaw na katutubong wika sa mga lalawigan ng Cavite, Laguna, Batangas, Rizal, Quezon o ang CALABARZON, sa lalawigan ng Marinduque at sa pulo ng Mindoro, sa Bulacan, sa Nueva Ecija, Aurora, Bataan, sa bayang Paracale sa lalawigan ng Camarines Norte, at sa Kalakhang Maynila.',
    },
  ],
})
