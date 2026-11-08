import { admitsOrdinal, type SequenceReads } from './vector-store/pins'
import { type StorePins, storePinsOf } from './vector-store/store-pins'
import type { SharedVectorStoreView } from './vector-store/view'

/**
 * A search reads one pinned state of a field's store through this object,
 * which reports the ordinals that the pin admits and the document that each
 * of them held in that state.
 *
 * @internal
 */
export interface OrdinalAdmission {
  /** The search reads the store at this write sequence. */
  readonly pin: number
  /** Reports whether the pinned state holds the ordinal's vector. */
  admits(ordinal: number): boolean
  /** Returns the document that the ordinal held in the pinned state, or undefined where the pin leaves the ordinal out. */
  docIdOf(ordinal: number): string | undefined
}

class PinnedOrdinals implements OrdinalAdmission {
  private readonly reads: SequenceReads

  constructor(
    private readonly view: SharedVectorStoreView,
    private readonly pins: StorePins,
    readonly pin: number,
  ) {
    this.reads = pins.currentReads()
  }

  admits(ordinal: number): boolean {
    const reads = this.reads
    if (ordinal >= 0 && ordinal * 2 + 1 < reads.born.length) {
      return admitsOrdinal(reads, ordinal, this.pin)
    }
    return this.pins.admits(ordinal, this.pin)
  }

  readonly docIdOf = (ordinal: number): string | undefined =>
    this.admits(ordinal) ? this.view.docIdAt(ordinal) : undefined
}

export function admissionAt(view: SharedVectorStoreView, pin: number): OrdinalAdmission {
  return new PinnedOrdinals(view, storePinsOf(view), pin)
}

export interface HeldAdmission {
  readonly admission: OrdinalAdmission
  release(): void
}

export function holdAdmission(view: SharedVectorStoreView, retainedSequence?: number): HeldAdmission {
  const pins = storePinsOf(view)
  const pin = retainedSequence ?? pins.take()
  if (retainedSequence !== undefined) pins.retain(retainedSequence)
  let released = false
  return {
    admission: admissionAt(view, pin),
    release() {
      if (released) return
      released = true
      pins.release(pin)
    },
  }
}

export function withTransientAdmission<T>(view: SharedVectorStoreView, search: (admission: OrdinalAdmission) => T): T {
  const pins = storePinsOf(view)
  const pin = pins.take()
  try {
    return search(admissionAt(view, pin))
  } finally {
    pins.release(pin)
  }
}

export async function withTransientAdmissionAsync<T>(
  view: SharedVectorStoreView,
  search: (admission: OrdinalAdmission) => Promise<T>,
): Promise<T> {
  const pins = storePinsOf(view)
  const pin = pins.take()
  try {
    return await search(admissionAt(view, pin))
  } finally {
    pins.release(pin)
  }
}
