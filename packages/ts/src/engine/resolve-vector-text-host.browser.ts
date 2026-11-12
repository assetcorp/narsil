import type { OptionalCodeHost } from './optional-code-host'

type EngineNames = Pick<OptionalCodeHost, 'ErrorCodes' | 'MAX_CALLS_ACROSS_INDEX_CHANGES' | 'NarsilError'>

export let ErrorCodes: EngineNames['ErrorCodes']
export let MAX_CALLS_ACROSS_INDEX_CHANGES: EngineNames['MAX_CALLS_ACROSS_INDEX_CHANGES']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>

export function bindResolveVectorTextHost(host: EngineNames): void {
  ;({ ErrorCodes, MAX_CALLS_ACROSS_INDEX_CHANGES, NarsilError } = host)
}
