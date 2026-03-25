import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

interface PointCloudProps {
  positions: Float32Array
  colors: Float32Array
  onHover: (index: number | null) => void
}

export function PointCloud({ positions, colors, onHover }: PointCloudProps) {
  const pointsRef = useRef<THREE.Points>(null)
  const hoveredRef = useRef<number | null>(null)
  const raycaster = useMemo(() => {
    const r = new THREE.Raycaster()
    r.params.Points = { threshold: 0.15 }
    return r
  }, [])
  const { camera, gl } = useThree()
  const mouseVec = useMemo(() => new THREE.Vector2(), [])

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geo
  }, [positions, colors])

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!pointsRef.current) return
      const canvas = gl.domElement
      const rect = canvas.getBoundingClientRect()
      mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouseVec, camera)
      const intersects = raycaster.intersectObject(pointsRef.current)
      const idx = intersects.length > 0 ? (intersects[0].index ?? null) : null
      if (idx !== hoveredRef.current) {
        hoveredRef.current = idx
        onHover(idx)
      }
    },
    [camera, gl, mouseVec, onHover, raycaster],
  )

  useEffect(() => {
    const canvas = gl.domElement
    canvas.addEventListener('pointermove', handlePointerMove)
    return () => canvas.removeEventListener('pointermove', handlePointerMove)
  }, [gl, handlePointerMove])

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial vertexColors sizeAttenuation size={0.08} transparent opacity={0.85} />
    </points>
  )
}
