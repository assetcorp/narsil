import { swahili } from '../../../languages/swahili'
import { defineLanguageFixture } from './types'

const SW_KENYA = "Swahili Wikipedia, article 'Kenya' (data/processed/wikipedia/wikipedia-sw.json)"
const SW_MAASAI = "Swahili Wikipedia, article 'Wamasai' (data/processed/wikipedia/wikipedia-sw.json)"

export const swahiliFixture = defineLanguageFixture({
  module: swahili,
  samples: [
    {
      text: "Vilevile, kuna shule kadhaa za kimataifa zinazofundisha mifumo mbalimbali ya elimu ya ng'ambo.",
      source: SW_KENYA,
    },
    {
      text: "Fasihi Ngugi wa Thiong'o ni mmoja wa waandishi maarufu wa Kenya.",
      source: SW_KENYA,
    },
    {
      text: "Kipindi hicho kiliainishwa na uenezi wa magonjwa ya bovin pleuropneumonia, tauni ya ng'ombe na ndui.",
      source: SW_MAASAI,
    },
  ],
  indivisible: ["ng'ombe", "ng'ambo", "thiong'o", 'zinazofundisha', 'waandishi'],
  separates: [
    { text: "tauni ya ng'ombe na ndui", tokens: ['tauni', 'ya', "ng'ombe", 'na', 'ndui'] },
    { text: "Ngugi wa Thiong'o ni mmoja", tokens: ['ngugi', 'wa', "thiong'o", 'ni', 'mmoja'] },
  ],
  equivalent: [
    ["ng'ombe", 'ng’ombe'],
    ['Kenya', 'kenya'],
  ],
  retrievable: [
    {
      query: "ng'ombe",
      text: "Kipindi hicho kiliainishwa na uenezi wa magonjwa ya bovin pleuropneumonia, tauni ya ng'ombe na ndui.",
    },
    {
      query: "ng'ambo",
      text: "Vilevile, kuna shule kadhaa za kimataifa zinazofundisha mifumo mbalimbali ya elimu ya ng'ambo.",
    },
  ],
})
