import type { QueuedWrite } from './types'

export class QueueMirror {
  private readonly writes = new Map<number, QueuedWrite>()
  private readonly sequencesByDocument = new Map<string, number[]>()
  private readonly uploaded = new Set<number>()

  get size(): number {
    return this.writes.size
  }

  reset(writes: readonly QueuedWrite[]): void {
    this.writes.clear()
    this.sequencesByDocument.clear()
    this.uploaded.clear()
    for (const write of [...writes].sort((a, b) => a.sequence - b.sequence)) this.add(write)
  }

  add(write: QueuedWrite): void {
    this.writes.set(write.sequence, write)
    const sequences = this.sequencesByDocument.get(write.documentId)
    if (sequences === undefined) this.sequencesByDocument.set(write.documentId, [write.sequence])
    else sequences.push(write.sequence)
  }

  remove(sequences: readonly number[]): void {
    for (const sequence of sequences) {
      const write = this.writes.get(sequence)
      if (write === undefined) continue
      this.writes.delete(sequence)
      this.uploaded.delete(sequence)
      const remaining = (this.sequencesByDocument.get(write.documentId) ?? []).filter(held => held !== sequence)
      if (remaining.length === 0) this.sequencesByDocument.delete(write.documentId)
      else this.sequencesByDocument.set(write.documentId, remaining)
    }
  }

  holdsDocument(documentId: string): boolean {
    return this.sequencesByDocument.has(documentId)
  }

  ordered(): QueuedWrite[] {
    return [...this.writes.values()].sort((a, b) => a.sequence - b.sequence)
  }

  latestAwaitingUpload(): QueuedWrite[] {
    const latest: QueuedWrite[] = []
    for (const sequences of this.sequencesByDocument.values()) {
      const newest = sequences[sequences.length - 1]
      if (newest === undefined || this.uploaded.has(newest)) continue
      const write = this.writes.get(newest)
      if (write !== undefined) latest.push(write)
    }
    return latest.sort((a, b) => a.sequence - b.sequence)
  }

  coveredBy(write: QueuedWrite): number[] {
    const sequences = this.sequencesByDocument.get(write.documentId) ?? []
    return sequences.filter(sequence => sequence <= write.sequence && !this.uploaded.has(sequence))
  }

  hasLaterWrite(write: QueuedWrite): boolean {
    const sequences = this.sequencesByDocument.get(write.documentId) ?? []
    return (sequences[sequences.length - 1] ?? 0) > write.sequence
  }

  markUploaded(sequences: readonly number[]): void {
    for (const sequence of sequences) {
      if (this.writes.has(sequence)) this.uploaded.add(sequence)
    }
  }

  forgetUploads(): void {
    this.uploaded.clear()
  }
}
