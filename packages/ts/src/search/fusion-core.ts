export interface FusionCore {
  fuse(
    strategy: number,
    k: number,
    alpha: number,
    textKeys: Uint32Array,
    textScores: Float64Array,
    vectorKeys: Uint32Array,
    vectorScores: Float64Array,
    idRanks: Uint32Array,
    keys: Uint32Array,
    scores: Float64Array,
  ): number
}

export function fusionCore(): FusionCore | undefined {
  return undefined
}
