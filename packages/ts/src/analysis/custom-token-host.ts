import type { OptionalCodeHost } from '../engine/optional-code-host'

type CustomTokenHost = Pick<OptionalCodeHost, 'ErrorCodes' | 'NarsilError' | 'withUnpairedSurrogatesReplaced'>

export let ErrorCodes: CustomTokenHost['ErrorCodes']
export let NarsilError: CustomTokenHost['NarsilError']
export let withUnpairedSurrogatesReplaced: CustomTokenHost['withUnpairedSurrogatesReplaced']

export function bindCustomTokenHost(host: CustomTokenHost): void {
  ;({ ErrorCodes, NarsilError, withUnpairedSurrogatesReplaced } = host)
}
