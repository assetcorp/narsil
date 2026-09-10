import type { SharedGraphHandles } from '../hnsw/handles'
import type { SharedVectorStoreHandles } from '../vector-store/handles'

/**
 * A thread opens these handles so that it can search one vector field in
 * place and place vectors in its graph, and they name the store's shared
 * structures alongside the graph's.
 *
 * The main thread sends them once, and again only when a block joins the
 * store or a fresh graph replaces the old one, because every other change
 * grows the shared buffers in place.
 *
 * @internal
 */
export interface SharedVectorFieldHandles {
  /** Every vector of the field has this many components. */
  dimension: number
  /** The threads compute quantised distances when this reads `sq8`. */
  quantization: 'sq8' | 'none'
  /** These are the store's shared structures. */
  store: SharedVectorStoreHandles
  /** These are the graph's shared structures, and they read null while the field answers by exact comparison. */
  graph: SharedGraphHandles | null
  /** A thread answers by exact comparison where a filter admits a smaller share of the live vectors than this. */
  filterThreshold: number
  /** This reads true where searches on the thread answer from the graph, and false while the threads build it. */
  searchable: boolean
}

/**
 * A thread reports this after placing a batch of vectors in a graph.
 *
 * @internal
 */
export interface GraphInsertOutcome {
  /** This reads true where a vector fell outside the quantiser's calibration, so the main thread recalibrates. */
  outsideCalibration: boolean
}
