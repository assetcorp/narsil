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

/**
 * This is one thread's handle on the graph's locks, naming the version word
 * of every node, the thread's own slot in the held-lock record, and the
 * header words that hold the graph lock and the entry lock.
 *
 * A node's word counts the writes to its lists, staying even between writes
 * and turning odd while a writer holds the node. A reader copies the lists
 * between two reads of that word, and it starts again where the word moved.
 * Every read therefore leaves the shared memory untouched, and a writer waits
 * for the previous writer alone.
 *
 * @internal
 */
export interface GraphLocks {
  readonly threadSlot: number
  readonly header: Int32Array
  readonly held: Int32Array
  words(ord: number): Int32Array
}

/**
 * Opens a graph's locks on the current thread.
 *
 * @param handles The graph whose locks to open.
 * @param threadSlot This thread's slot in the held-lock record.
 * @returns The thread's handle on those locks.
 *
 * @internal
 */
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

/**
 * Reads a node's version word, spinning while a writer holds it.
 *
 * @param locks This thread's handle on the graph's locks.
 * @param ord The node to read.
 * @returns The version the read started under.
 *
 * @internal
 */
export function beginNodeRead(locks: GraphLocks, ord: number): number {
  const words = locks.words(ord)
  for (;;) {
    const seen = Atomics.load(words, ord)
    if ((seen & WRITE_HELD) === 0) return seen
  }
}

/**
 * Reports whether a node's lists stayed still through a read that started
 * under the given version, fencing the reader's copies before it checks.
 *
 * @param locks This thread's handle on the graph's locks.
 * @param ord The node the reader copied.
 * @param version The version {@link beginNodeRead} returned.
 * @returns True where the copy holds one whole list.
 *
 * @internal
 */
export function nodeReadHeld(locks: GraphLocks, ord: number, version: number): boolean {
  Atomics.add(locks.held, heldIndex(locks, HELD_FENCE), 0)
  return Atomics.load(locks.words(ord), ord) === version
}

/**
 * Takes a node's lock for writing, excluding every other writer and marking
 * the node's lists in flux for readers.
 *
 * @param locks This thread's handle on the graph's locks.
 * @param ord The node to lock.
 *
 * @internal
 */
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

/**
 * Releases a node's write lock, moving its version on and waking a writer
 * that queued behind it.
 *
 * @param locks This thread's handle on the graph's locks.
 * @param ord The node to release.
 *
 * @internal
 */
export function unlockNodeWrite(locks: GraphLocks, ord: number): void {
  releaseWrite(locks.words(ord), ord)
  Atomics.store(locks.held, heldIndex(locks, HELD_WRITE), 0)
}

/**
 * Takes the graph lock in shared mode, which every search and every insertion
 * holds until it finishes, so that an operation needing the whole graph to
 * itself waits for them. It waits itself while another thread is queueing for
 * the whole graph, which keeps a rebuild from waiting behind an endless run
 * of searches.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
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

/**
 * Releases the graph lock held in shared mode.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
export function unlockGraphShared(locks: GraphLocks): void {
  const { header } = locks
  Atomics.store(locks.held, heldIndex(locks, HELD_GRAPH), 0)
  if (Atomics.sub(header, GRAPH_LOCK, 1) === 1 && canWait(header)) Atomics.notify(header, GRAPH_LOCK)
}

/**
 * Takes the graph lock exclusively, waiting for every search and insertion in
 * flight to finish, for an operation that rewrites the graph in place. It
 * records that it is waiting, so that the searches in flight are the only
 * ones it waits for.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
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

/**
 * Releases the graph lock held exclusively.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
export function unlockGraphExclusive(locks: GraphLocks): void {
  releaseExclusive(locks.header, GRAPH_LOCK)
}

/**
 * Takes the short lock that guards the entry point and top layer together.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
export function lockEntry(locks: GraphLocks): void {
  acquireExclusive(locks.header, GRAPH_ENTRY_LOCK)
}

/**
 * Releases the entry point lock.
 *
 * @param locks This thread's handle on the graph's locks.
 *
 * @internal
 */
export function unlockEntry(locks: GraphLocks): void {
  releaseExclusive(locks.header, GRAPH_ENTRY_LOCK)
}

/**
 * Frees every lock a thread slot held, after that thread died mid-operation,
 * so that no other thread waits on it for ever.
 *
 * @param handles The graph the thread was working on.
 * @param threadSlot The dead thread's slot.
 *
 * @internal
 */
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
