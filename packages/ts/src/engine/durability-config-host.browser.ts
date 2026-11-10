import type { OptionalCodeHost } from './optional-code-host'

type EngineNames = Pick<OptionalCodeHost, 'ErrorCodes' | 'MAX_FILE_BYTES' | 'NarsilError'>

export let ErrorCodes: EngineNames['ErrorCodes']
export let MAX_FILE_BYTES: EngineNames['MAX_FILE_BYTES']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>

export function bindDurabilityConfigHost(host: EngineNames): void {
  ;({ ErrorCodes, MAX_FILE_BYTES, NarsilError } = host)
}
