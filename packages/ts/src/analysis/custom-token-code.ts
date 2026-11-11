import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import type * as CustomTokenResults from './custom-token-results'

type CustomTokenCode = typeof CustomTokenResults

const customTokenCode = codeLoader<CustomTokenCode>(
  () =>
    import('./custom-token-results').then(code => {
      code.bindCustomTokenHost(optionalCodeHost())
      return code
    }),
  'custom tokenizer',
)

export function loadCustomTokenCodeFor(tokenizers: readonly unknown[]): Promise<CustomTokenCode> | null {
  if (customTokenCode.loaded() !== null) return null
  for (const tokenizer of tokenizers) if (tokenizer !== undefined && tokenizer !== null) return customTokenCode.load()
  return null
}

export const customTokensOf: CustomTokenCode['customTokensOf'] = (...parameters) =>
  customTokenCode.require().customTokensOf(...parameters)
