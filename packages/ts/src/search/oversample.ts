/**
 * Computes the oversampled per-node count for a distributed aggregation: half
 * again the requested size plus ten. Facet buckets and grouped results both
 * oversample through this one formula, so the two stay tied the way the
 * specification ties them.
 *
 * @param size - The count the client asked for.
 * @returns The count each node returns.
 */
export function oversampledShardSize(size: number): number {
  return Math.ceil(size * 1.5) + 10
}
