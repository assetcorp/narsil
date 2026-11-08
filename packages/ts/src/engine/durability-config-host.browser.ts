import type { OptionalCodeHost } from './optional-code-host'

type EngineNames = Pick<OptionalCodeHost, 'ErrorCodes' | 'NarsilError'>

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>

export function bindDurabilityConfigHost(host: EngineNames): void {
  ;({ ErrorCodes, NarsilError } = host)
}
