import { codeLoader } from '../workers/code-loader'
import { optionalCodeHost } from './optional-code-host'
import type * as ResolveVectorText from './resolve-vector-text'

export type ResolveVectorTextCode = typeof ResolveVectorText

const resolveVectorText = codeLoader<ResolveVectorTextCode>(
  () =>
    import('./resolve-vector-text').then(code => {
      code.bindResolveVectorTextHost(optionalCodeHost())
      return code
    }),
  'vector text',
)

export const loadResolveVectorText = resolveVectorText.load
