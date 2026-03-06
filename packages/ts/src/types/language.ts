export interface LanguageModule {
  name: string
  stemmer: ((token: string) => string) | null
  stopWords: Set<string>
  tokenizer?: TokenizerConfig
}

export interface TokenizerConfig {
  splitPattern?: RegExp
  normalizeDiacritics?: boolean
  minTokenLength?: number
}
