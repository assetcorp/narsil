type OptionalReads = typeof import('../../engine/optional-reads')

export type PartialExpansionCode = Pick<
  OptionalReads,
  | 'PARTIAL_BUDGET'
  | 'PARTIAL_RUN_POINTS'
  | 'captureExpansionSource'
  | 'expansionDictionary'
  | 'expansionText'
  | 'expansionToken'
  | 'readExpansion'
  | 'validExpansionText'
>

export let PARTIAL_BUDGET: PartialExpansionCode['PARTIAL_BUDGET']
export let PARTIAL_RUN_POINTS: PartialExpansionCode['PARTIAL_RUN_POINTS']
export let captureExpansionSource: PartialExpansionCode['captureExpansionSource']
export let expansionDictionary: PartialExpansionCode['expansionDictionary']
export let expansionText: PartialExpansionCode['expansionText']
export let expansionToken: PartialExpansionCode['expansionToken']
export let readExpansion: PartialExpansionCode['readExpansion']
export let validExpansionText: PartialExpansionCode['validExpansionText']

export function bindPartialExpansionCode(code: PartialExpansionCode): void {
  ;({
    PARTIAL_BUDGET,
    PARTIAL_RUN_POINTS,
    captureExpansionSource,
    expansionDictionary,
    expansionText,
    expansionToken,
    readExpansion,
    validExpansionText,
  } = code)
}
