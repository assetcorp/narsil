/**
 * Opens and closes durable indexes without deleting them.
 *
 * @public
 */
export interface IndexLifecycleOperations {
  /**
   * Loads a closed index from its durable checkpoint and resets a parked recovery failure.
   *
   * @param indexName - The index to load.
   * @returns A promise that settles when the index is ready for operations.
   */
  open(indexName: string): Promise<void>
  /**
   * Drains active work, checkpoints the index, releases its memory, and keeps its durable files.
   *
   * @param indexName - The index to close.
   * @returns A promise that settles after the index releases its memory.
   */
  close(indexName: string): Promise<void>
}
