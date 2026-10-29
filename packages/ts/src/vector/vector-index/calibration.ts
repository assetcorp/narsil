import { RECALIBRATION_CHUNK_VECTORS, RECALIBRATION_DRIFT_RATIO } from './constants'
import { driftRatio, type LiveVectorMean, measureLiveVectors, nextDriftCheck } from './drift'
import { type VectorIndexState, yieldBuildTurn } from './shared'
import { noteWrite } from './worker-copies'

function noteCalibration(state: VectorIndexState, live: LiveVectorMean): void {
  state.calibratedCount = live.count
  state.calibratedMeanLength = state.metric === 'cosine' ? live.meanLength : null
  state.nextDriftCheckAt = nextDriftCheck(live.count, live.count)
}

async function recodeEveryVector(state: VectorIndexState, live: LiveVectorMean): Promise<boolean> {
  const quantizer = state.osq
  if (quantizer === null) return false
  quantizer.beginRecoding(live.centroid)
  try {
    for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
      if (state.disposed || state.osq !== quantizer) {
        quantizer.abandonRecoding()
        return false
      }
      quantizer.recode(ordinal)
      if ((ordinal + 1) % RECALIBRATION_CHUNK_VECTORS === 0) await yieldBuildTurn(state)
    }
    const graph = state.hnsw
    return graph === null ? quantizer.finishRecoding() : graph.exclusively(() => quantizer.finishRecoding())
  } catch (error) {
    quantizer.abandonRecoding()
    throw error
  }
}

export async function calibrateFromLiveVectors(state: VectorIndexState, live: LiveVectorMean): Promise<boolean> {
  const quantizer = state.osq
  if (quantizer === null || state.disposed) return false
  if (quantizer.isCalibrated()) {
    if (!(await recodeEveryVector(state, live))) return false
    noteWrite(state)
  } else {
    quantizer.restoreCentroid(live.centroid)
  }
  noteCalibration(state, live)
  return true
}

export async function calibrateBeforeBuild(state: VectorIndexState): Promise<boolean> {
  if (state.osq === null) return true
  const live = await measureLiveVectors(state, state.osq)
  return live !== null && (await calibrateFromLiveVectors(state, live))
}

export async function recalibrateWhenDrifted(state: VectorIndexState, held: number): Promise<boolean> {
  if (state.osq === null || held < state.nextDriftCheckAt) return false
  const live = await measureLiveVectors(state, state.osq)
  const calibrated = state.osq?.centroid ?? null
  const calibratedCount = state.calibratedCount
  if (live === null) return false
  if (calibrated !== null && calibratedCount !== null) {
    const ratio = driftRatio(live, calibrated, calibratedCount, state.calibratedMeanLength, state.metric)
    if (ratio <= RECALIBRATION_DRIFT_RATIO) {
      state.nextDriftCheckAt = nextDriftCheck(calibratedCount, live.count)
      return false
    }
  }
  return calibrateFromLiveVectors(state, live)
}
