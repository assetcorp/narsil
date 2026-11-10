import type { OptionalCodeHost } from '../engine/optional-code-host'

type CustomTokenHost = Pick<
  OptionalCodeHost,
  'ErrorCodes' | 'MAX_TOKEN_POSITION' | 'NarsilError' | 'withUnpairedSurrogatesReplaced'
>

export let ErrorCodes: CustomTokenHost['ErrorCodes']
export let MAX_TOKEN_POSITION: CustomTokenHost['MAX_TOKEN_POSITION']
export let NarsilError: CustomTokenHost['NarsilError']
export let withUnpairedSurrogatesReplaced: CustomTokenHost['withUnpairedSurrogatesReplaced']

export function bindCustomTokenHost(host: CustomTokenHost): void {
  ;({ ErrorCodes, MAX_TOKEN_POSITION, NarsilError, withUnpairedSurrogatesReplaced } = host)
}
