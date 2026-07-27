import { italian } from '../../../languages/italian'
import { defineLanguageFixture } from './types'

const IT_WIKIPEDIA = "Italian Wikipedia, article 'Lingua italiana' (https://it.wikipedia.org/wiki/Lingua_italiana)"
const IT_MANZONI = "Italian Wikipedia, article 'Alessandro Manzoni' (https://it.wikipedia.org/wiki/Alessandro_Manzoni)"

export const italianFixture = defineLanguageFixture({
  module: italian,
  samples: [
    {
      text: "L'italiano è una lingua romanza parlata principalmente in Italia.",
      source: IT_WIKIPEDIA,
    },
    {
      text: "Per ragioni storiche e geografiche, l'italiano è la lingua romanza meno divergente dal latino.",
      source: IT_WIKIPEDIA,
    },
    {
      text: 'È diffuso nelle comunità di emigrazione italiana, è ampiamente noto anche per ragioni pratiche in diverse aree geografiche ed è una delle lingue straniere più studiate nel mondo.',
      source: IT_WIKIPEDIA,
    },
    {
      text: 'Scritta "genî" non può che riferirsi al primo significato.',
      source: IT_WIKIPEDIA,
    },
    {
      text: "Altrove l'accento grafico è facoltativo, ma utile per distinguere parole altrimenti omografe (àncora - ancóra).",
      source: IT_WIKIPEDIA,
    },
    {
      text: 'Nelle occasioni soprattutto informali che avvengono in ambiti nazionali, i partecipanti usano la loro lingua nazionale (in Francia il francese e così via).',
      source: IT_WIKIPEDIA,
    },
    {
      text: "Anche Leopardi, che non ammirava né condivideva l'ideologia e la poetica manzoniana, lo salutò cordialmente.",
      source: IT_MANZONI,
    },
  ],
  indivisible: [
    'italiano',
    'comunità',
    'romanza',
    'geografiche',
    'genî',
    'principî',
    'ancóra',
    'àncora',
    'così',
    'né',
    'salutò',
  ],
  separates: [
    {
      text: "L'italiano è una lingua romanza parlata principalmente in Italia.",
      tokens: ['l', 'italiano', 'è', 'una', 'lingua', 'romanza', 'parlata', 'principalmente', 'in', 'italia'],
    },
    { text: "l'italiano è la lingua romanza", tokens: ['l', 'italiano', 'è', 'la', 'lingua', 'romanza'] },
    { text: 'in Francia il francese e così via', tokens: ['in', 'francia', 'il', 'francese', 'e', 'così', 'via'] },
    { text: 'non ammirava né condivideva', tokens: ['non', 'ammirava', 'né', 'condivideva'] },
    { text: 'omografe àncora e ancóra', tokens: ['omografe', 'àncora', 'e', 'ancóra'] },
  ],
  equivalent: [
    ["l'italiano", 'l’italiano'],
    ['Italiano', 'italiano'],
  ],
  retrievable: [
    { query: 'italiano', text: "L'italiano è una lingua romanza parlata principalmente in Italia." },
    {
      query: 'comunità',
      text: 'È diffuso nelle comunità di emigrazione italiana, è ampiamente noto anche per ragioni pratiche in diverse aree geografiche ed è una delle lingue straniere più studiate nel mondo.',
    },
    {
      query: 'ancóra',
      text: "Altrove l'accento grafico è facoltativo, ma utile per distinguere parole altrimenti omografe (àncora - ancóra).",
    },
    {
      query: 'così',
      text: 'Nelle occasioni soprattutto informali che avvengono in ambiti nazionali, i partecipanti usano la loro lingua nazionale (in Francia il francese e così via).',
    },
    {
      query: 'salutò',
      text: "Anche Leopardi, che non ammirava né condivideva l'ideologia e la poetica manzoniana, lo salutò cordialmente.",
    },
  ],
})
