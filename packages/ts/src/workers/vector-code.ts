import type * as VectorModule from '../vector/module'
import { codeLoader } from './code-loader'

export type VectorCode = typeof VectorModule

const vectorCode = codeLoader<VectorCode>(() => import('../vector/module'), 'vector')

export const loadedVectorCode = vectorCode.loaded
export const requireLoadedVectorCode = vectorCode.require
export const loadVectorCode = vectorCode.load
export const loadVectorCodeFor = vectorCode.loadFor
