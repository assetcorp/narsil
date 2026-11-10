import { optionalCodeHost } from '../engine/optional-code-host'
import type * as VectorModule from '../vector/module'
import { codeLoader } from './code-loader'
import { loadVectorCore } from './vector-core-code'

export type VectorCode = typeof VectorModule

const vectorCode = codeLoader<VectorCode>(async () => {
  const [vectorCore, code] = await Promise.all([loadVectorCore(), import('../vector/module')])
  code.bindVectorHost(optionalCodeHost(), vectorCore)
  return code
}, 'vector')

export const loadedVectorCode = vectorCode.loaded
export const requireLoadedVectorCode = vectorCode.require
export const loadVectorCode = vectorCode.load
export const loadVectorCodeFor = vectorCode.loadFor
