import { loadSegmentCodec } from '../core/segment-codec-code'
import { loadSegmentMerge } from '../core/segment-merge-code'
import { codeLoader } from '../workers/code-loader'
import { optionalCodeHost } from './optional-code-host'
import type * as WorkerCopies from './worker-copies'

export type WorkerCopiesCode = typeof WorkerCopies

const workerCopies = codeLoader<WorkerCopiesCode>(async () => {
  const [segmentCodec, segmentMerge, code] = await Promise.all([
    loadSegmentCodec(),
    loadSegmentMerge(),
    import('./worker-copies'),
  ])
  code.bindWorkerCopiesHost(optionalCodeHost(), segmentCodec, segmentMerge)
  return code
}, 'worker copy')

export const loadWorkerCopies = workerCopies.load
