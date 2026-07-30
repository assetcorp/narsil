import { telugu } from '../../../languages/telugu'
import { defineLanguageFixture } from './types'

const TE_LANGUAGE = "Telugu Wikipedia, article 'తెలుగు' (https://te.wikipedia.org/wiki/తెలుగు)"

export const teluguFixture = defineLanguageFixture({
  module: telugu,
  samples: [
    {
      text: 'తెలుగు తెలంగాణ, ఆంధ్ర రాష్ట్రాలలోని అధికారిక భాష.',
      source: TE_LANGUAGE,
    },
    {
      text: 'ఒడిశా, కర్ణాటక, తమిళనాడు, కేరళ, పంజాబ్, ఛత్తీస్‌గఢ్, మహారాష్ట్ర, అండమాన్ నికోబార్ దీవులలో గుర్తింపబడిన ద్వితీయ అధికారిక భాష.',
      source: TE_LANGUAGE,
    },
  ],
  indivisible: ['తెలుగు', 'తెలంగాణ', 'అధికారిక', 'ఛత్తీస్‌గఢ్'],
  separates: [
    {
      text: 'ఇది ద్రావిడ భాషా కుటుంబానికి చెందిన భాష',
      tokens: ['ఇది', 'ద్రావిడ', 'భాషా', 'కుటుంబానికి', 'చెందిన', 'భాష'],
    },
    {
      text: 'గుర్తింపబడిన ద్వితీయ అధికారిక భాష',
      tokens: ['గుర్తింపబడిన', 'ద్వితీయ', 'అధికారిక', 'భాష'],
    },
  ],
  equivalent: [['ఛత్తీస్‌గఢ్', 'ఛత్తీస్గఢ్']],
  retrievable: [
    {
      query: 'తెలంగాణ',
      text: 'తెలుగు తెలంగాణ, ఆంధ్ర రాష్ట్రాలలోని అధికారిక భాష.',
    },
    {
      query: 'గుర్తింపబడిన',
      text: 'ఒడిశా, కర్ణాటక, తమిళనాడు, కేరళ, పంజాబ్, ఛత్తీస్‌గఢ్, మహారాష్ట్ర, అండమాన్ నికోబార్ దీవులలో గుర్తింపబడిన ద్వితీయ అధికారిక భాష.',
    },
  ],
})
