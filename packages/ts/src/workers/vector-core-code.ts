import { optionalCodeHost } from '../engine/optional-code-host'
import { markSimdUnavailable } from '../runtime/simd-support'
import type * as VectorCoreLeaf from '../vector/core-leaf'
import { codeLoader } from './code-loader'

export type VectorCore = typeof VectorCoreLeaf

const vectorCore = codeLoader<VectorCore>(
  () =>
    import('../vector/core-leaf').then(code => {
      code.bindVectorCoreHost(optionalCodeHost())
      if (!code.simdModuleLoaded()) markSimdUnavailable()
      return code
    }),
  'vector core',
)

export const loadVectorCore = vectorCore.load
