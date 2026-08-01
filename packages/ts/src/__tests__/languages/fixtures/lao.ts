import { lao } from '../../../languages/lao'
import { defineLanguageFixture } from './types'

const LO_LANGUAGE = "Lao Wikipedia, article 'ພາສາລາວ' (https://lo.wikipedia.org/wiki/ພາສາລາວ)"
const LO_COUNTRY = "Lao Wikipedia, article 'ປະເທດລາວ' (https://lo.wikipedia.org/wiki/ປະເທດລາວ)"

export const laoFixture = defineLanguageFixture({
  module: lao,
  samples: [
    {
      text: 'ພາສາລາວ ແມ່ນພາສາຕະກຸນໄຕ-ກະໄດຂອງຄົນລາວ',
      source: LO_LANGUAGE,
    },
    {
      text: 'ປະເທດລາວ ຫຼື ຊື່ຢ່າງເປັນທາງການຄື ສາທາລະນະລັດ ປະຊາທິປະໄຕ ປະຊາຊົນລາວ',
      source: LO_COUNTRY,
    },
  ],
  indivisible: ['ຫຼື', 'ໃນ'],
  separates: [
    {
      text: 'ພາສາລາວ',
      tokens: ['ພາ', 'າສ', 'ສາ', 'າລ', 'ລາ', 'າວ'],
    },
    {
      text: 'ປະຊາຊົນລາວ',
      tokens: ['ປະ', 'ະຊ', 'ຊາ', 'າຊົ', 'ຊົນ', 'ນລ', 'ລາ', 'າວ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ພາສາ',
      text: 'ພາສາລາວ ແມ່ນພາສາຕະກຸນໄຕ-ກະໄດຂອງຄົນລາວ',
    },
    {
      query: 'ສາທາລະນະລັດ',
      text: 'ປະເທດລາວ ຫຼື ຊື່ຢ່າງເປັນທາງການຄື ສາທາລະນະລັດ ປະຊາທິປະໄຕ ປະຊາຊົນລາວ',
    },
  ],
})
