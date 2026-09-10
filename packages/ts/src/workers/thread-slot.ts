/**
 * Reports the slot a worker uses inside every shared vector block and every
 * graph's lock record, counted up from one because the main thread holds slot
 * zero.
 *
 * @param workerId The worker's id in its pool.
 * @returns The worker's slot.
 *
 * @internal
 */
export function threadSlotOfWorker(workerId: number): number {
  return workerId + 1
}
