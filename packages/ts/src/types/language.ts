export interface LanguageModule {
  name: string
  revision: string
  stemmer: ((token: string) => string) | null
  stopWords: Set<string>
  normalizer?: (token: string) => string
  tokenizer?: TokenizerConfig
}

export interface TokenizerConfig {
  splitPattern?: RegExp
  normalizeDiacritics?: boolean
  minTokenLength?: number
  stripPossessive?: boolean
  ngramSize?: number
}
