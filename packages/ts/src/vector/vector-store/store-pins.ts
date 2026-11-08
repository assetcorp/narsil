import { fixedView } from '../shared-buffers/growable'
import { writeSequenceWords } from './handles'
import { admitsOrdinal, createThreadPins, type SequenceReads, type ThreadPins } from './pins'
import type { SharedVectorStoreView } from './view'

/**
 * This thread pins one field's store through this object, and it reads which
 * ordinals a pin admits through it.
 *
 * @internal
 */
export interface StorePins {
  /** Pins the store at its current write sequence and returns that sequence. */
  take(): number
  /** Retains a sequence that another holder protects until this call returns. */
  retain(sequence: number): void
  /** Releases one pin that {@link StorePins.take} returned. */
  release(pin: number): void
  /** Reports whether a pin admits an ordinal: its vector was added at or before the pin, and nothing retired it by then. */
  admits(ordinal: number, pin: number): boolean
  /** Returns the views of the born and retired tables that cover the store's current handles. */
  currentReads(): SequenceReads
  /** Counts the pins that this thread holds on the store. */
  readonly held: number
}

const pinsByView = new WeakMap<SharedVectorStoreView, StorePins>()

function readsOf(view: SharedVectorStoreView): SequenceReads {
  const { bornAt, retiredAt } = view.handles
  return {
    born: fixedView(bornAt, Uint32Array),
    retired: fixedView(retiredAt, Uint32Array),
    retiredExact: fixedView(retiredAt, BigInt64Array),
  }
}

function createStorePins(view: SharedVectorStoreView): StorePins {
  let boundTo = view.handles
  let reads = readsOf(view)
  let headerWords = boundTo.header
  let header = writeSequenceWords(headerWords)
  const thread: ThreadPins = createThreadPins(
    () => view.handles.pins,
    () => {
      if (view.handles.header !== headerWords) {
        headerWords = view.handles.header
        header = writeSequenceWords(headerWords)
      }
      return header
    },
    view.threadSlot,
  )

  function covers(ordinal: number): boolean {
    if (boundTo !== view.handles || ordinal * 2 + 1 >= reads.born.length) {
      boundTo = view.handles
      reads = readsOf(view)
    }
    return ordinal >= 0 && ordinal * 2 + 1 < reads.born.length
  }

  return {
    take: () => thread.take(),
    retain: sequence => thread.retain(sequence),
    release: pin => thread.release(pin),
    admits(ordinal, pin) {
      return covers(ordinal) && admitsOrdinal(reads, ordinal, pin)
    },
    currentReads() {
      if (boundTo !== view.handles) {
        boundTo = view.handles
        reads = readsOf(view)
      }
      return reads
    },
    get held() {
      return thread.held
    },
  }
}

export function storePinsOf(view: SharedVectorStoreView): StorePins {
  let pins = pinsByView.get(view)
  if (pins === undefined) {
    pins = createStorePins(view)
    pinsByView.set(view, pins)
  }
  return pins
}
