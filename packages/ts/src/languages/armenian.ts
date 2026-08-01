/*
 * Stop words sourced from:
 *   - Apache Lucene hy stopwords (https://github.com/apache/lucene), Apache-2.0
 *
 * The stemmer is generated from Snowball's algorithms/armenian.sbl; see snowball/build.ts.
 */

import type { LanguageModule } from '../types/language'
import { revision, stem } from './snowball/armenian'

const stopWords = new Set([
  '\u0561\u0575\u0564',
  '\u0561\u0575\u056c',
  '\u0561\u0575\u0576',
  '\u0561\u0575\u057d',
  '\u0564\u0578\u0582',
  '\u0564\u0578\u0582\u0584',
  '\u0565\u0574',
  '\u0565\u0576',
  '\u0565\u0576\u0584',
  '\u0565\u057d',
  '\u0565\u0584',
  '\u0567',
  '\u0567\u056b',
  '\u0567\u056b\u0576',
  '\u0567\u056b\u0576\u0584',
  '\u0567\u056b\u0580',
  '\u0567\u056b\u0584',
  '\u0567\u0580',
  '\u0568\u057d\u057f',
  '\u0569',
  '\u056b',
  '\u056b\u0576',
  '\u056b\u057d\u056f',
  '\u056b\u0580',
  '\u056f\u0561\u0574',
  '\u0570\u0561\u0574\u0561\u0580',
  '\u0570\u0565\u057f',
  '\u0570\u0565\u057f\u0578',
  '\u0574\u0565\u0576\u0584',
  '\u0574\u0565\u057b',
  '\u0574\u056b',
  '\u0576',
  '\u0576\u0561',
  '\u0576\u0561\u0587',
  '\u0576\u0580\u0561',
  '\u0576\u0580\u0561\u0576\u0584',
  '\u0578\u0580',
  '\u0578\u0580\u0568',
  '\u0578\u0580\u0578\u0576\u0584',
  '\u0578\u0580\u057a\u0565\u057d',
  '\u0578\u0582',
  '\u0578\u0582\u0574',
  '\u057a\u056b\u057f\u056b',
  '\u057e\u0580\u0561',
  '\u0587',
])

export const armenian: LanguageModule = {
  name: 'armenian',
  revision,
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^\u0531-\u0556\u0561-\u0587a-z0-9]+/gi },
}
