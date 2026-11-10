import { codeLoader } from '../workers/code-loader'
import type * as DurabilityConfig from './durability-config'
import { optionalCodeHost } from './optional-code-host'

export type DurabilityConfigCode = typeof DurabilityConfig

const durabilityConfig = codeLoader<DurabilityConfigCode>(
  () =>
    import('./durability-config').then(code => {
      code.bindDurabilityConfigHost(optionalCodeHost())
      return code
    }),
  'durability',
)

export const loadDurabilityConfig = durabilityConfig.load
