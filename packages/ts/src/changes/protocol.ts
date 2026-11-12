import { isSyncEpoch } from '#platform/storage-host'
import type { ChangePosition } from '../types/changes'

export type SubscriberMessage =
  | { type: 'subscribe'; epoch?: string; positions?: ChangePosition[]; filter?: unknown }
  | { type: 'ack'; positions: ChangePosition[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function isSeqNo(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function absent(value: unknown): boolean {
  return value === undefined || value === null
}

export function changePositionsOf(raw: unknown): ChangePosition[] | null {
  if (!Array.isArray(raw)) return null
  const positions: ChangePosition[] = []
  for (const item of raw) {
    if (!isRecord(item) || !isUint32(item.partitionId) || !isSeqNo(item.seqNo)) return null
    positions.push({ partitionId: item.partitionId, seqNo: item.seqNo })
  }
  return positions
}

export function seqNosByPartition(positions: readonly ChangePosition[], partitionCount: number): number[] | null {
  if (positions.length !== partitionCount) return null
  const seqNos = new Array<number>(partitionCount).fill(-1)
  for (const { partitionId, seqNo } of positions) {
    if (partitionId >= partitionCount || seqNos[partitionId] !== -1) return null
    seqNos[partitionId] = seqNo
  }
  return seqNos
}

export function changePositionList(seqNos: readonly number[]): ChangePosition[] {
  return seqNos.map((seqNo, partitionId) => ({ partitionId, seqNo }))
}

export function subscriberMessageOf(raw: unknown): SubscriberMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'subscribe': {
      if (absent(raw.epoch) !== absent(raw.positions)) return null
      const filter = absent(raw.filter) ? {} : { filter: raw.filter }
      if (absent(raw.epoch)) return { type: 'subscribe', ...filter }
      const positions = changePositionsOf(raw.positions)
      if (!isSyncEpoch(raw.epoch) || positions === null) return null
      return { type: 'subscribe', epoch: raw.epoch, positions, ...filter }
    }
    case 'ack': {
      const positions = changePositionsOf(raw.positions)
      return positions === null ? null : { type: 'ack', positions }
    }
    default:
      return null
  }
}
