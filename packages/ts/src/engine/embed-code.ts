import { codeLoader } from '../workers/code-loader'
import type * as EmbedModule from './embed'
import { optionalCodeHost } from './optional-code-host'

export type EmbedCode = typeof EmbedModule

const embedCode = codeLoader<EmbedCode>(
  () =>
    import('./embed').then(code => {
      code.bindEmbedHost(optionalCodeHost())
      return code
    }),
  'embedding',
)

export const loadEmbedCode = embedCode.load
