import { codeLoader } from '../workers/code-loader'
import type * as DigestLeaf from './durability/digest-leaf'

export type Digest = typeof DigestLeaf

const digest = codeLoader<Digest>(() => import('./durability/digest-leaf'), 'digest')

export const loadDigest = digest.load
