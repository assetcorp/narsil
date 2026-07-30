import { zulu } from '../../../languages/zulu'
import { defineLanguageFixture } from './types'

const ZU_LANGUAGE = "Zulu Wikipedia, article 'IsiZulu' (data/processed/wikipedia/wikipedia-zu.json)"
const ZU_LANGUAGE_UNIT =
  "Zulu Wikipedia, article 'Uphiko Lwezilimi Kuzwelonke' (data/processed/wikipedia/wikipedia-zu.json)"

export const zuluFixture = defineLanguageFixture({
  module: zulu,
  samples: [
    {
      text: 'Ngo 1994 isiZulu sabekwa njengolunye lwezilimu eziyishumi nanye (11) ezisemthethweni eNingizimu Afrika.',
      source: ZU_LANGUAGE,
    },
    {
      text: 'Abantu abakhuluma isiZulu babizwa ngama Zulu.',
      source: ZU_LANGUAGE,
    },
    {
      text: 'I-NLS isebenza njengeziko lonongoti bezilimi abayisisekelo sikaHulumeni ngokuhumushela kuzo zonke izilimi ezisemthethweni imibhalo nemiqulu yakwaHulumeni.',
      source: ZU_LANGUAGE_UNIT,
    },
  ],
  indivisible: ['isizulu', 'i-nls', 'yakwahulumeni', 'ezisemthethweni', 'abayingxenye', 'i-afrika'],
  separates: [
    {
      text: 'Abantu abakhuluma isiZulu babizwa ngama Zulu.',
      tokens: ['abantu', 'abakhuluma', 'isizulu', 'babizwa', 'ngama', 'zulu'],
    },
    { text: 'I-NLS isebenza njengeziko lonongoti', tokens: ['i-nls', 'isebenza', 'njengeziko', 'lonongoti'] },
  ],
  equivalent: [['IsiZulu', 'isizulu']],
  retrievable: [
    { query: 'isizulu', text: 'Abantu abakhuluma isiZulu babizwa ngama Zulu.' },
    {
      query: 'i-nls',
      text: 'I-NLS isebenza njengeziko lonongoti bezilimi abayisisekelo sikaHulumeni ngokuhumushela kuzo zonke izilimi ezisemthethweni imibhalo nemiqulu yakwaHulumeni.',
    },
  ],
})
