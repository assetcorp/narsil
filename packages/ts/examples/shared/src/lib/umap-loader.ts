export interface UmapBounds {
  center: [number, number, number]
  radius: number
}

export interface UmapData {
  positions: Float32Array
  ids: string[]
  count: number
  bounds: UmapBounds
}

export async function loadUmapData(basePath: string, prefix: string): Promise<UmapData> {
  const [binResponse, idsResponse] = await Promise.all([
    fetch(`${basePath}${prefix}-umap-3d.bin`),
    fetch(`${basePath}${prefix}-vector-ids.json`),
  ])

  if (!binResponse.ok) {
    throw new Error(`Failed to load UMAP binary: ${binResponse.status}`)
  }
  if (!idsResponse.ok) {
    throw new Error(`Failed to load vector IDs: ${idsResponse.status}`)
  }

  const [buffer, ids] = await Promise.all([binResponse.arrayBuffer(), idsResponse.json() as Promise<string[]>])

  const view = new DataView(buffer)
  const count = view.getUint32(0, true)
  const dims = view.getUint32(4, true)

  if (dims !== 3) {
    throw new Error(`Expected 3D UMAP data, got ${dims} dimensions`)
  }

  const positions = new Float32Array(buffer, 8, count * 3)

  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < count; i++) {
    cx += positions[i * 3]
    cy += positions[i * 3 + 1]
    cz += positions[i * 3 + 2]
  }
  cx /= count
  cy /= count
  cz /= count

  let maxDistSq = 0
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - cx
    const dy = positions[i * 3 + 1] - cy
    const dz = positions[i * 3 + 2] - cz
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq > maxDistSq) maxDistSq = distSq
  }

  const bounds: UmapBounds = {
    center: [cx, cy, cz],
    radius: Math.sqrt(maxDistSq),
  }

  return { positions, ids, count, bounds }
}
