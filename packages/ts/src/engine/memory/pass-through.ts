import type { MemoryReservation, MemoryWriteBlock } from './write-block'

const NO_RESERVATION: MemoryReservation = { release() {} }

export const PASS_THROUGH_WRITE_BLOCK: MemoryWriteBlock = {
  refuseWhileFull() {},
  reserveFor: () => NO_RESERVATION,
  async applyInGroups(_indexName, write) {
    if (write.items.length > 0) await write.apply(write.items)
    return null
  },
  refuseRemaining() {},
}
