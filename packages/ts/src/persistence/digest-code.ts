import { codeLoader } from '../workers/code-loader'
import type * as Sha256 from './durability/sha256'

export type Digest = typeof Sha256

const digest = codeLoader<Digest>(() => import('./durability/sha256'), 'digest')

export const loadDigest = digest.load
