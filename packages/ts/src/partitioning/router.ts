import { fnv1a } from '../core/hash'
import { ErrorCodes, NarsilError } from '../errors'

export interface PartitionRouter {
  route(docId: string, partitionCount: number): number
  routeBatch(docIds: string[], partitionCount: number): Map<number, string[]>
}

export function createPartitionRouter(): PartitionRouter {
  function route(docId: string, partitionCount: number): number {
    if (partitionCount <= 0) {
      throw new NarsilError(
        ErrorCodes.INDEX_NOT_FOUND,
        `Partition count must be greater than 0, received ${partitionCount}`,
        { partitionCount },
      )
    }
    return fnv1a(docId) % partitionCount
  }

  function routeBatch(docIds: string[], partitionCount: number): Map<number, string[]> {
    const groups = new Map<number, string[]>()
    for (let i = 0; i < docIds.length; i++) {
      const pid = route(docIds[i], partitionCount)
      let group = groups.get(pid)
      if (!group) {
        group = []
        groups.set(pid, group)
      }
      group.push(docIds[i])
    }
    return groups
  }

  return { route, routeBatch }
}
