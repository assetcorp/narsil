import type { OptionalCodeHost } from '../engine/optional-code-host'

type PhraseHost = Pick<
  OptionalCodeHost,
  | 'bitsetHas'
  | 'bitsetSet'
  | 'ErrorCodes'
  | 'GrowableUint32'
  | 'MAX_PHRASE_WORDS'
  | 'MAX_QUERY_PHRASES'
  | 'NarsilError'
  | 'regionsOverlap'
  | 'typedRegion'
>

export let bitsetHas: PhraseHost['bitsetHas']
export let bitsetSet: PhraseHost['bitsetSet']
export let ErrorCodes: PhraseHost['ErrorCodes']
export let GrowableUint32: PhraseHost['GrowableUint32']
export type GrowableUint32 = InstanceType<PhraseHost['GrowableUint32']>
export let MAX_PHRASE_WORDS: PhraseHost['MAX_PHRASE_WORDS']
export let MAX_QUERY_PHRASES: PhraseHost['MAX_QUERY_PHRASES']
export let NarsilError: PhraseHost['NarsilError']
export let regionsOverlap: PhraseHost['regionsOverlap']
export let typedRegion: PhraseHost['typedRegion']

export function bindPhraseHost(host: PhraseHost): void {
  ;({
    bitsetHas,
    bitsetSet,
    ErrorCodes,
    GrowableUint32,
    MAX_PHRASE_WORDS,
    MAX_QUERY_PHRASES,
    NarsilError,
    regionsOverlap,
    typedRegion,
  } = host)
}
