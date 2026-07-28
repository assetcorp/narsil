import { german } from '../../../languages/german'
import { defineLanguageFixture } from './types'

const DE_LANGUAGE = "German Wikipedia, article 'Deutsche Sprache' (https://de.wikipedia.org/wiki/Deutsche_Sprache)"
const DE_CAFE = "German Wikipedia, article 'Café' (https://de.wikipedia.org/wiki/Café)"

export const germanFixture = defineLanguageFixture({
  module: german,
  samples: [
    {
      text: 'Das Deutsche ist eine plurizentrische Sprache, enthält also mehrere Standardvarietäten in verschiedenen Regionen.',
      source: DE_LANGUAGE,
    },
    {
      text: 'Deutsch ist die meistgesprochene Muttersprache in der Europäischen Union.',
      source: DE_LANGUAGE,
    },
    {
      text: 'Zu den ältesten heute noch bestehenden Kaffeehäusern zählt das angeblich 1686 eröffnete „Café Procope“ in Paris.',
      source: DE_CAFE,
    },
    {
      text: 'Das Standarddeutsche überspannt als Dachsprache den Großteil der Mundarten des Dialektkontinuums.',
      source: DE_LANGUAGE,
    },
  ],
  indivisible: [
    'café',
    'kaffeehäusern',
    'standardvarietäten',
    'plurizentrische',
    'straße',
    'größe',
    'überspannt',
    'großteil',
    'dialektkontinuums',
  ],
  separates: [
    { text: '„Café Procope“ in Paris', tokens: ['café', 'procope', 'in', 'paris'] },
    {
      text: 'Deutsch ist die meistgesprochene Muttersprache',
      tokens: ['deutsch', 'ist', 'die', 'meistgesprochene', 'muttersprache'],
    },
    {
      text: 'überspannt als Dachsprache den Großteil',
      tokens: ['überspannt', 'als', 'dachsprache', 'den', 'grossteil'],
    },
  ],
  equivalent: [
    ['Straße', 'Strasse'],
    ['Café', 'café'],
  ],
  retrievable: [
    {
      query: 'café',
      text: 'Zu den ältesten heute noch bestehenden Kaffeehäusern zählt das angeblich 1686 eröffnete „Café Procope“ in Paris.',
    },
    {
      query: 'muttersprache',
      text: 'Deutsch ist die meistgesprochene Muttersprache in der Europäischen Union.',
    },
    {
      query: 'überspannt',
      text: 'Das Standarddeutsche überspannt als Dachsprache den Großteil der Mundarten des Dialektkontinuums.',
    },
  ],
})
