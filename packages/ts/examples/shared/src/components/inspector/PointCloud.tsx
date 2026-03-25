import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

interface PointCloudProps {
  positions: Float32Array
  colors: Float32Array
  selectedIndex: number | null
  neighborIndices: number[]
  onHover: (index: number | null) => void
  onClick: (index: number | null) => void
}

const NEIGHBOR_LINE_COLOR = new THREE.Color(1, 0.85, 0.2)
const BASE_RADIUS = 0.035
const HOVERED_SCALE = 2.0
const SELECTED_SCALE = 2.8
const NEIGHBOR_SCALE = 1.8

const tempObject = new THREE.Object3D()
const tempColor = new THREE.Color()

const sphereGeo = new THREE.SphereGeometry(1, 12, 8)

export function PointCloud({ positions, colors, selectedIndex, neighborIndices, onHover, onClick }: PointCloudProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const hoveredRef = useRef<number | null>(null)
  const prevHoveredRef = useRef<number | null>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const { camera, gl } = useThree()
  const mouseVec = useMemo(() => new THREE.Vector2(), [])
  const count = positions.length / 3

  const neighborSet = useMemo(() => new Set(neighborIndices), [neighborIndices])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    for (let i = 0; i < count; i++) {
      let scale = BASE_RADIUS
      if (i === selectedIndex) {
        scale = BASE_RADIUS * SELECTED_SCALE
      } else if (neighborSet.has(i)) {
        scale = BASE_RADIUS * NEIGHBOR_SCALE
      }

      tempObject.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      tempObject.scale.setScalar(scale)
      tempObject.updateMatrix()
      mesh.setMatrixAt(i, tempObject.matrix)

      const r = colors[i * 3]
      const g = colors[i * 3 + 1]
      const b = colors[i * 3 + 2]

      if (selectedIndex !== null && i !== selectedIndex && !neighborSet.has(i)) {
        tempColor.setRGB(r * 0.25, g * 0.25, b * 0.25)
      } else {
        tempColor.setRGB(r, g, b)
      }
      mesh.setColorAt(i, tempColor)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [positions, colors, count, selectedIndex, neighborSet])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return

    const prev = prevHoveredRef.current
    const curr = hoveredRef.current

    if (prev !== null && prev !== selectedIndex && !neighborSet.has(prev)) {
      tempObject.position.set(positions[prev * 3], positions[prev * 3 + 1], positions[prev * 3 + 2])
      tempObject.scale.setScalar(BASE_RADIUS)
      tempObject.updateMatrix()
      mesh.setMatrixAt(prev, tempObject.matrix)
    }

    if (curr !== null) {
      const baseScale =
        curr === selectedIndex
          ? BASE_RADIUS * SELECTED_SCALE
          : neighborSet.has(curr)
            ? BASE_RADIUS * NEIGHBOR_SCALE
            : BASE_RADIUS
      tempObject.position.set(positions[curr * 3], positions[curr * 3 + 1], positions[curr * 3 + 2])
      tempObject.scale.setScalar(baseScale * HOVERED_SCALE)
      tempObject.updateMatrix()
      mesh.setMatrixAt(curr, tempObject.matrix)
    }

    mesh.instanceMatrix.needsUpdate = true
    prevHoveredRef.current = curr
  })

  const connectionLines = useMemo(() => {
    if (selectedIndex === null || neighborIndices.length === 0) return null

    const sx = positions[selectedIndex * 3]
    const sy = positions[selectedIndex * 3 + 1]
    const sz = positions[selectedIndex * 3 + 2]

    const linePositions = new Float32Array(neighborIndices.length * 6)
    for (let i = 0; i < neighborIndices.length; i++) {
      const ni = neighborIndices[i]
      linePositions[i * 6] = sx
      linePositions[i * 6 + 1] = sy
      linePositions[i * 6 + 2] = sz
      linePositions[i * 6 + 3] = positions[ni * 3]
      linePositions[i * 6 + 4] = positions[ni * 3 + 1]
      linePositions[i * 6 + 5] = positions[ni * 3 + 2]
    }

    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
    return lineGeo
  }, [positions, selectedIndex, neighborIndices])

  const raycastPoint = useCallback(
    (e: PointerEvent): number | null => {
      const mesh = meshRef.current
      if (!mesh) return null
      const canvas = gl.domElement
      const rect = canvas.getBoundingClientRect()
      mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouseVec, camera)
      const intersects = raycaster.intersectObject(mesh)
      if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
        return intersects[0].instanceId
      }
      return null
    },
    [camera, gl, mouseVec, raycaster],
  )

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const idx = raycastPoint(e)
      if (idx !== hoveredRef.current) {
        hoveredRef.current = idx
        onHover(idx)
      }
    },
    [raycastPoint, onHover],
  )

  const pointerDownPos = useRef<{ x: number; y: number } | null>(null)

  const handlePointerDown = useCallback((e: PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (!pointerDownPos.current) return
      const dx = e.clientX - pointerDownPos.current.x
      const dy = e.clientY - pointerDownPos.current.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      pointerDownPos.current = null
      if (distance > 5) return
      const idx = raycastPoint(e)
      onClick(idx)
    },
    [raycastPoint, onClick],
  )

  useEffect(() => {
    const canvas = gl.domElement
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointerup', handlePointerUp)
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointerup', handlePointerUp)
    }
  }, [gl, handlePointerMove, handlePointerDown, handlePointerUp])

  return (
    <>
      <instancedMesh ref={meshRef} args={[sphereGeo, undefined, count]}>
        <meshStandardMaterial roughness={0.6} metalness={0.1} />
      </instancedMesh>
      {connectionLines && (
        <lineSegments geometry={connectionLines}>
          <lineBasicMaterial color={NEIGHBOR_LINE_COLOR} transparent opacity={0.6} />
        </lineSegments>
      )}
    </>
  )
}
