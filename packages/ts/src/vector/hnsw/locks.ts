import { LOCK_SPIN_ITERATIONS, LOCK_WAIT_SLICE_MS } from '../constants'
import { fixedView, growBufferTo, sharedMemoryAvailable } from '../shared-buffers/growable'
import {
  GRAPH_ENTRY_LOCK,
  GRAPH_LOCK,
  GRAPH_WRITERS_WAITING,
  HELD_FENCE,
  HELD_GRAPH,
  HELD_GRAPH_WAITING,
  HELD_WORDS_PER_THREAD,
  HELD_WRITE,
  HELD_WRITE_VERSION,
  type SharedGraphHandles,
} from './handles'

const FREE = 0
const EXCLUSIVE = -1

declare const document: unknown

export interface GraphLocks {
  readonly threadSlot: number
  readonly header: Int32Array
  readonly held: Int32Array
  words(ord: number): Int32Array
}

export function openGraphLocks(handles: SharedGraphHandles, threadSlot: number): GraphLocks {
  let words = fixedView(handles.locks, Int32Array)
  return {
    threadSlot,
    header: handles.header,
    held: handles.heldLocks,
    words(ord: number) {
      if (ord < words.length) return words
      if (ord * 4 >= handles.locks.byteLength) growBufferTo(handles.locks, (ord + 1) * 4)
      words = fixedView(handles.locks, Int32Array)
      return words
    },
  }
}

const blockingAllowed = typeof document === 'undefined'

function canWait(words: Int32Array): boolean {
  return blockingAllowed && sharedMemoryAvailable() && words.buffer instanceof SharedArrayBuffer
}

function waitOn(words: Int32Array, index: number, seen: number): void {
  if (!canWait(words)) return
  Atomics.wait(words, index, seen, LOCK_WAIT_SLICE_MS)
}

function heldIndex(locks: GraphLocks, kind: number): number {
  return locks.threadSlot * HELD_WORDS_PER_THREAD + kind
}

function acquireExclusive(words: Int32Array, index: number): void {
  let spins = 0
  for (;;) {
    const seen = Atomics.compareExchange(words, index, FREE, EXCLUSIVE)
    if (seen === FREE) return
    if (spins < LOCK_SPIN_ITERATIONS) {
      spins += 1
      continue
    }
    waitOn(words, index, seen)
  }
}

function releaseExclusive(words: Int32Array, index: number): void {
  Atomics.store(words, index, FREE)
  if (canWait(words)) Atomics.notify(words, index)
}

const WRITE_HELD = 1
const WRITER_WAITING = 2
const VERSION_STEP = 4

export function beginNodeRead(locks: GraphLocks, ord: number): number {
  const words = locks.words(ord)
  for (;;) {
    const seen = Atomics.load(words, ord)
    if ((seen & WRITE_HELD) === 0) return seen
  }
}

export function nodeReadHeld(locks: GraphLocks, ord: number, version: number): boolean {
  Atomics.add(locks.held, heldIndex(locks, HELD_FENCE), 0)
  return Atomics.load(locks.words(ord), ord) === version
}

export function lockNodeWrite(locks: GraphLocks, ord: number): void {
  const words = locks.words(ord)
  let spins = 0
  for (;;) {
    const seen = Atomics.load(words, ord)
    if ((seen & WRITE_HELD) === 0) {
      const claimed = seen | WRITE_HELD
      if (Atomics.compareExchange(words, ord, seen, claimed) === seen) {
        Atomics.store(locks.held, heldIndex(locks, HELD_WRITE_VERSION), claimed)
        Atomics.store(locks.held, heldIndex(locks, HELD_WRITE), ord + 1)
        return
      }
      continue
    }
    if (spins < LOCK_SPIN_ITERATIONS) {
      spins += 1
      continue
    }
    const waiting = seen | WRITER_WAITING
    if (waiting === seen || Atomics.compareExchange(words, ord, seen, waiting) === seen) {
      waitOn(words, ord, waiting)
    }
  }
}

function releaseWrite(words: Int32Array, ord: number): void {
  const seen = Atomics.load(words, ord)
  const previous = Atomics.exchange(words, ord, (seen & ~(WRITE_HELD | WRITER_WAITING)) + VERSION_STEP)
  if ((previous & WRITER_WAITING) !== 0 && canWait(words)) Atomics.notify(words, ord)
}

export function unlockNodeWrite(locks: GraphLocks, ord: number): void {
  releaseWrite(locks.words(ord), ord)
  Atomics.store(locks.held, heldIndex(locks, HELD_WRITE), 0)
}

export function lockGraphShared(locks: GraphLocks): void {
  const { header } = locks
  let spins = 0
  for (;;) {
    const seen = Atomics.load(header, GRAPH_LOCK)
    if (seen >= FREE && Atomics.load(header, GRAPH_WRITERS_WAITING) === 0) {
      if (Atomics.compareExchange(header, GRAPH_LOCK, seen, seen + 1) === seen) {
        Atomics.store(locks.held, heldIndex(locks, HELD_GRAPH), 1)
        return
      }
      continue
    }
    if (spins < LOCK_SPIN_ITERATIONS) {
      spins += 1
      continue
    }
    waitOn(header, GRAPH_LOCK, seen)
  }
}

export function unlockGraphShared(locks: GraphLocks): void {
  const { header } = locks
  Atomics.store(locks.held, heldIndex(locks, HELD_GRAPH), 0)
  if (Atomics.sub(header, GRAPH_LOCK, 1) === 1 && canWait(header)) Atomics.notify(header, GRAPH_LOCK)
}

export function lockGraphExclusive(locks: GraphLocks): void {
  Atomics.store(locks.held, heldIndex(locks, HELD_GRAPH_WAITING), 1)
  Atomics.add(locks.header, GRAPH_WRITERS_WAITING, 1)
  try {
    acquireExclusive(locks.header, GRAPH_LOCK)
  } finally {
    Atomics.sub(locks.header, GRAPH_WRITERS_WAITING, 1)
    Atomics.store(locks.held, heldIndex(locks, HELD_GRAPH_WAITING), 0)
  }
}

export function unlockGraphExclusive(locks: GraphLocks): void {
  releaseExclusive(locks.header, GRAPH_LOCK)
}

export function lockEntry(locks: GraphLocks): void {
  acquireExclusive(locks.header, GRAPH_ENTRY_LOCK)
}

export function unlockEntry(locks: GraphLocks): void {
  releaseExclusive(locks.header, GRAPH_ENTRY_LOCK)
}

export function releaseLocksHeldBy(handles: SharedGraphHandles, threadSlot: number): void {
  const held = handles.heldLocks
  const words = new Int32Array(handles.locks)
  const base = threadSlot * HELD_WORDS_PER_THREAD
  if (Atomics.exchange(held, base + HELD_GRAPH_WAITING, 0) === 1) {
    Atomics.sub(handles.header, GRAPH_WRITERS_WAITING, 1)
  }
  const writeOrd = Atomics.exchange(held, base + HELD_WRITE, 0) - 1
  const writeVersion = Atomics.load(held, base + HELD_WRITE_VERSION)
  if (writeOrd >= 0 && writeOrd < words.length) {
    const seen = Atomics.load(words, writeOrd)
    if ((seen & ~WRITER_WAITING) === writeVersion) releaseWrite(words, writeOrd)
  }
  if (Atomics.exchange(held, base + HELD_GRAPH, 0) !== 1) return
  for (;;) {
    const readers = Atomics.load(handles.header, GRAPH_LOCK)
    if (readers <= FREE) return
    if (Atomics.compareExchange(handles.header, GRAPH_LOCK, readers, readers - 1) === readers) {
      if (canWait(handles.header)) Atomics.notify(handles.header, GRAPH_LOCK)
      return
    }
  }
}
