const goneThreadSlots = new Set<number>()

export function threadSlotOfWorker(workerId: number): number {
  return workerId + 1
}

export function noteThreadSlotLive(threadSlot: number): void {
  goneThreadSlots.delete(threadSlot)
}

export function noteThreadSlotGone(threadSlot: number): void {
  goneThreadSlots.add(threadSlot)
}

export function threadSlotGone(threadSlot: number): boolean {
  return goneThreadSlots.has(threadSlot)
}
