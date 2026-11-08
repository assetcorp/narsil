import { MAX_LAYER_CAP, osqRecordBytes } from '#platform/storage-host'
import { COLD_GRAPH_PART_VECTORS } from '../constants'
import { loadFailed } from '../format'
import type { ColdGraph, ColdGraphPart, ColdVectorFieldInput, OpenedFiles } from './open-files'

const UINT32_MAX = 0xffff_ffff

export function validateColdLayout(
  input: ColdVectorFieldInput,
  opened: OpenedFiles,
  parts: readonly ColdGraphPart[],
  graph: ColdGraph,
): void {
  const { dimension } = input
  const { codes, files } = opened
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > UINT32_MAX)
    loadFailed('The disk vector field holds an invalid dimension')
  if (codes !== null && (codes.centroid.length !== dimension || codes.centroid.some(value => !Number.isFinite(value))))
    loadFailed('The disk vector field holds an invalid centroid')
  let total = 0
  for (const file of files) {
    if (
      !Number.isInteger(file.count) ||
      file.count <= 0 ||
      file.count > UINT32_MAX - total ||
      file.firstNumber !== total ||
      file.vectors.length !== file.count * dimension * Float32Array.BYTES_PER_ELEMENT ||
      (file.dead !== null && file.dead.length !== Math.ceil(file.count / 8)) ||
      (codes !== null && file.records?.length !== file.count * osqRecordBytes(dimension, codes.bits))
    )
      loadFailed(`The vector ranges of "${file.file.path}" do not match the field`)
    total += file.count
  }
  if (
    !Number.isInteger(graph.maxLayer) ||
    graph.maxLayer < 0 ||
    graph.maxLayer > MAX_LAYER_CAP ||
    (graph.entryPoint !== null &&
      (!Number.isInteger(graph.entryPoint) || graph.entryPoint < 0 || graph.entryPoint >= total)) ||
    parts.length !== Math.ceil(total / COLD_GRAPH_PART_VECTORS)
  )
    loadFailed('The disk vector graph does not cover the field')
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]
    const count = Math.min(total - at * COLD_GRAPH_PART_VECTORS, COLD_GRAPH_PART_VECTORS)
    const { levels, nodeOffsets } = part
    if (levels.length !== count || nodeOffsets.length !== count + 1 || nodeOffsets[0] !== 0)
      loadFailed(`The node ranges of "${part.file.path}" do not match the field`)
    for (let node = 0; node < count; node++) {
      if (
        levels[node] > graph.maxLayer + 1 ||
        nodeOffsets[node] > nodeOffsets[node + 1] ||
        nodeOffsets[node + 1] > part.neighbours.length
      )
        loadFailed(`The node at position ${node} of "${part.file.path}" has invalid layers or offsets`)
    }
  }
}
