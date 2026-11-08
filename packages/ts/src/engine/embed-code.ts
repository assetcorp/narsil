import { codeLoader } from '../workers/code-loader'
import type * as EmbedModule from './embed'

export type EmbedCode = typeof EmbedModule

const embedCode = codeLoader<EmbedCode>(() => import('./embed'), 'embedding')

export const loadEmbedCode = embedCode.load
