/*
 * Stop words sourced from:
 *   - Apache Lucene te stopwords (https://github.com/apache/lucene), Apache-2.0
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'అడగడం',
  'అడగండి',
  'అడ్డంగా',
  'అందరూ',
  'అందుబాటులో',
  'అనుగుణంగా',
  'అనుమతించు',
  'అనుమతిస్తుంది',
  'అయితే',
  'ఇప్పటికే',
  'ఉన్నారు',
  'ఎక్కడైనా',
  'ఎప్పుడు',
  'ఎవరైనా',
  'ఏ',
  'ఏదైనా',
  'ఏమైనప్పటికి',
  'ఒక',
  'కనిపిస్తాయి',
  'కాదు',
  'కూడా',
  'గా',
  'గురించి',
  'చుట్టూ',
  'చేయగలిగింది',
  'తగిన',
  'తర్వాత',
  'దాదాపు',
  'దూరంగా',
  'నిజంగా',
  'పై',
  'ప్రకారం',
  'మధ్య',
  'మరియు',
  'మరొక',
  'మళ్ళీ',
  'మాత్రమే',
  'మెచ్చుకో',
  'వద్ద',
  'వెంట',
  'వేరుగా',
  'వ్యతిరేకంగా',
  'సంబంధం',
])

const ZERO_WIDTH_NON_JOINER = /\u200c/g

function normalize(token: string): string {
  return token.replace(ZERO_WIDTH_NON_JOINER, '')
}

export const telugu: LanguageModule = {
  name: 'telugu',
  stemmer: null,
  stopWords,
  normalizer: normalize,
  tokenizer: { splitPattern: /[^\u0c00-\u0c7f\u200ca-z0-9]+/gi },
}
