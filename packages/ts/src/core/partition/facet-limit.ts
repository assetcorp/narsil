export function keptFacetValues(limit: number | undefined): number | undefined {
  return limit !== undefined && limit > 0 ? Math.floor(limit) : undefined
}
