import type { VectorMaintenanceResult } from './results'

/**
 * Reports on and rebuilds the graphs of an index's vector fields.
 *
 * @public
 */
export interface VectorMaintenanceOperations {
  /**
   * Rebuilds a vector field's graph without the tombstones removed documents
   * left behind, which returns the memory they held and speeds searches up.
   *
   * Read {@link VectorMaintenanceOperations.vectorMaintenanceStatus} first to
   * see whether the work is worth its cost.
   *
   * @param indexName - The index holding the field.
   * @param fieldName - The vector field to compact. Omit it to compact every
   * vector field in the index.
   */
  compactVectors(indexName: string, fieldName?: string): Promise<void>
  /**
   * Rebuilds a vector field's graph from scratch, which recovers the recall a
   * long run of inserts and removals costs.
   *
   * This is heavier than {@link VectorMaintenanceOperations.compactVectors} and
   * gives a better graph, so run it once a search starts missing documents it
   * should find, rather than on a schedule.
   *
   * @param indexName - The index holding the field.
   * @param fieldName - The vector field to rebuild. Omit it to rebuild every
   * vector field in the index.
   */
  optimizeVectors(indexName: string, fieldName?: string): Promise<void>
  /**
   * Reports the state of each vector field in an index, and what compaction or
   * optimisation would cost.
   *
   * @param indexName - The index to describe.
   * @returns One entry per vector field, or an empty list while the index is closed.
   */
  vectorMaintenanceStatus(indexName: string): VectorMaintenanceResult[]
}
