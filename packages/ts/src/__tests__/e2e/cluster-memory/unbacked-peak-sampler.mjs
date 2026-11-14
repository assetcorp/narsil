import { workerData } from 'node:worker_threads'
import { memoryThatNoFileBacks } from '../../runtime/process-memory-oracle.mjs'

const SAMPLE_INTERVAL_MS = 1
const PEAK_SLOT = 0
const SAMPLES_SLOT = 1

const figures = new BigInt64Array(workerData.figures)
const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

for (;;) {
  const unbacked = BigInt(memoryThatNoFileBacks())
  if (unbacked > Atomics.load(figures, PEAK_SLOT)) Atomics.store(figures, PEAK_SLOT, unbacked)
  Atomics.add(figures, SAMPLES_SLOT, 1n)
  Atomics.wait(pause, 0, 0, SAMPLE_INTERVAL_MS)
}
