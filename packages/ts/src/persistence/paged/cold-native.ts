import {
  compareCodePoints,
  compareScores,
  createFixedBuffer,
  defaultEfSearch,
  defaultRescoreDepth,
  ErrorCodes,
  NarsilError,
  requireSearchActive,
  signalOfSearch,
} from '#platform/storage-host'
import type { NativeCore } from '../../vector/native/types'
import type {
  NativePagedGraphPart,
  NativePagedVectorField,
  NativePagedVectorFile,
  NativePagedVectorRequest,
} from '../../vector/native/types/paged'
import type { VectorScoredResult } from '../../vector/vector-index/shared'
import { COLD_GRAPH_PART_VECTORS, type ColdFieldData } from './cold-field'
import type { ColdSearchOptions } from './cold-search'
import { failNativePage } from './native-file'

const STOPPED = -7
const WORK_CAP = 0x7fff_ffff_ffff_ffffn
const UINT64_MAX = 0xffff_ffff_ffff_ffffn
const NANOSECONDS_PER_MILLISECOND = 1_000_000

function fieldOf(data: ColdFieldData, metric: ColdSearchOptions['metric']): NativePagedVectorField | null {
  const files: NativePagedVectorFile[] = []
  for (const file of data.files) {
    const vectors = file.vectors.native
    const records = data.codes === null ? null : (file.records?.native ?? null)
    if (vectors === null || (data.codes !== null && records === null)) return null
    files.push({ first: file.firstNumber, count: file.count, dead: file.dead, vectors, records })
  }
  const graphParts: NativePagedGraphPart[] = []
  for (let at = 0; at < data.parts.length; at++) {
    const part = data.parts[at]
    const neighbours = part.neighbours.native
    if (neighbours === null) return null
    graphParts.push({
      first: at * COLD_GRAPH_PART_VECTORS,
      count: part.levels.length,
      levels: part.levels,
      nodeOffsets: part.nodeOffsets,
      neighbours,
    })
  }
  return {
    dimension: data.dimension,
    metric: metric === 'cosine' ? 0 : metric === 'dotProduct' ? 1 : 2,
    total: data.total,
    entryPoint: data.graph.entryPoint,
    maxLayer: data.graph.maxLayer,
    codes: data.codes,
    files,
    graphParts,
  }
}

function admission(data: ColdFieldData, accepts: ((id: string) => boolean) | null): Uint32Array | null {
  if (accepts === null) return null
  const mask = new Uint32Array(Math.max(1, Math.ceil(data.total / 32)))
  for (let ordinal = 0; ordinal < data.total; ordinal++) {
    if (!data.isDeadNumber(ordinal) && accepts(data.idAt(ordinal))) mask[ordinal >>> 5] |= 1 << (ordinal & 31)
  }
  return mask
}

function excludedMask(total: number, excluded: ReadonlySet<number>): Uint32Array | null {
  if (excluded.size === 0) return null
  const mask = new Uint32Array(Math.max(1, Math.ceil(total / 32)))
  for (const ordinal of excluded) {
    if (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < total) mask[ordinal >>> 5] |= 1 << (ordinal & 31)
  }
  return mask
}

function reportFailure(data: ColdFieldData, status: number, fault: BigUint64Array): never {
  let path = ''
  let section = fault[1].toString()
  for (const file of data.files) {
    if (file.file.native?.handle.identity !== fault[0]) continue
    path = file.file.path
    if (file.vectors.native?.offset === fault[1]) section = 'vectors'
    else if (file.records?.native?.offset === fault[1]) section = 'records'
    break
  }
  for (const part of data.parts) {
    if (part.file.native?.handle.identity !== fault[0]) continue
    path = part.file.path
    section = 'neighbours'
    break
  }
  return failNativePage(status, path, section, fault[2])
}

function deadlineFor(core: NativeCore, milliseconds: number | undefined): BigUint64Array {
  const deadline = new BigUint64Array(1)
  if (milliseconds !== undefined) {
    const status = core.clockNow(deadline)
    if (status !== 0 || !Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The search clock could not be read', { status })
    }
    const expires = deadline[0] + BigInt(Math.ceil(milliseconds * NANOSECONDS_PER_MILLISECOND))
    deadline[0] = expires > UINT64_MAX ? UINT64_MAX : expires
  }
  return deadline
}

function prepareSearch(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
  shared: boolean,
) {
  const file = data.files[0]?.file
  const native = file?.native
  if (native === undefined || native === null || file === undefined) return null
  const field = fieldOf(data, options.metric)
  if (field === null) return null
  const window = options.rescoreWindow ?? k
  let depth = window
  if (data.codes !== null) {
    depth =
      options.oversample === undefined
        ? defaultRescoreDepth(data.codes.bits, data.dimension, window)
        : Math.ceil(window * options.oversample)
  }
  const ef = Math.max(options.efSearch ?? defaultEfSearch(data.dimension, window), depth)
  const capacity = Math.min(data.total, ef)
  const allocate = (bytes: number): ArrayBufferLike => (shared ? createFixedBuffer(bytes) : new ArrayBuffer(bytes))
  const ordinals = new Uint32Array(allocate(capacity * Uint32Array.BYTES_PER_ELEMENT))
  const scores = new Float64Array(allocate(capacity * Float64Array.BYTES_PER_ELEMENT))
  const fault = new BigUint64Array(allocate(3 * BigUint64Array.BYTES_PER_ELEMENT))
  const meter = new BigInt64Array(allocate(2 * BigInt64Array.BYTES_PER_ELEMENT))
  meter[1] = WORK_CAP
  const signal = signalOfSearch(options.clock)
  const stop = new Uint32Array(allocate(Uint32Array.BYTES_PER_ELEMENT))
  const accepted = admission(data, accepts)
  const rejected = excludedMask(data.total, excluded)
  options.clock?.check()
  requireSearchActive(stop, signal)
  const timed = options.clock?.nativeWindow?.()
  const deadline = deadlineFor(native.core, timed?.milliseconds)
  const request: NativePagedVectorRequest = {
    query,
    k,
    ef,
    rescoreDepth: depth,
    explicitRescoreWindow: options.rescoreWindow !== undefined,
    minSimilarity: options.minSimilarity,
    accepted,
    excluded: rejected,
  }
  const abort = (): void => {
    Atomics.store(stop, 0, 1)
  }
  signal?.addEventListener('abort', abort, { once: true })
  return {
    core: native.core,
    cache: file.cache,
    field,
    request,
    meter,
    stop,
    deadline,
    ordinals,
    scores,
    fault,
    release(): void {
      signal?.removeEventListener('abort', abort)
    },
    finish(count: number): VectorScoredResult[] {
      requireSearchActive(stop, signal)
      options.clock?.tick(Number(meter[0]))
      if (count === STOPPED && timed !== undefined) timed.expired()
      if (count < 0) reportFailure(data, count, fault)
      const hits: VectorScoredResult[] = []
      for (let at = 0; at < count; at++) hits.push({ docId: data.idAt(ordinals[at]), score: scores[at] })
      hits.sort((left, right) => compareScores(left.score, right.score) || compareCodePoints(left.docId, right.docId))
      return hits.slice(0, k)
    },
  }
}

export function searchNativeColdGraph(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
): VectorScoredResult[] | null {
  const search = prepareSearch(data, query, k, options, accepts, excluded, false)
  if (search === null) return null
  const { core, field, request, meter, stop, deadline, ordinals, scores, fault } = search
  try {
    return search.finish(
      core.searchPagedVectors(field, request, search.cache.pageCache(), meter, stop, deadline, ordinals, scores, fault),
    )
  } finally {
    search.release()
  }
}

export function searchNativeColdGraphConcurrently(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
): Promise<VectorScoredResult[]> | null {
  const search = prepareSearch(data, query, k, options, accepts, excluded, true)
  if (search === null) return null
  const { core, field, request, meter, stop, deadline, ordinals, scores, fault } = search
  return search.cache
    .withPageCache(async cache => {
      const count = await core.searchPagedVectorsAsync(
        field,
        request,
        cache,
        meter,
        stop,
        deadline,
        ordinals,
        scores,
        fault,
      )
      return search.finish(count)
    })
    .finally(search.release)
}
