import { describe, expect, it } from 'vitest'
import { haversineDistance } from '../../geo/haversine'
import { vincentyDistance } from '../../geo/vincenty'

describe('vincentyDistance', () => {
  it('returns 0 for the same point', () => {
    expect(vincentyDistance(51.5074, -0.1278, 51.5074, -0.1278)).toBe(0)
  })

  it('computes the distance from London to Paris (~344 km)', () => {
    const distance = vincentyDistance(51.5074, -0.1278, 48.8566, 2.3522)
    expect(distance / 1000).toBeCloseTo(343.9, 0)
  })

  it('computes the distance from New York to Los Angeles (~3944 km)', () => {
    const distance = vincentyDistance(40.7128, -74.006, 34.0522, -118.2437)
    expect(distance / 1000).toBeCloseTo(3944, 0)
  })

  it('is symmetric: d(A, B) equals d(B, A)', () => {
    const d1 = vincentyDistance(51.5074, -0.1278, 48.8566, 2.3522)
    const d2 = vincentyDistance(48.8566, 2.3522, 51.5074, -0.1278)
    expect(d1).toBeCloseTo(d2, 2)
  })

  it('agrees with haversine for short distances (< 0.5% difference)', () => {
    const vDist = vincentyDistance(5.6037, -0.187, 5.7037, -0.087)
    const hDist = haversineDistance(5.6037, -0.187, 5.7037, -0.087)
    const relativeDiff = Math.abs(vDist - hDist) / hDist
    expect(relativeDiff).toBeLessThan(0.005)
  })

  it('falls back to haversine for nearly antipodal points', () => {
    const distance = vincentyDistance(0, 0, 0.5, 179.5)
    expect(distance).toBeGreaterThan(0)
    expect(Number.isFinite(distance)).toBe(true)
  })

  it('computes a transcontinental distance with higher accuracy', () => {
    const vDist = vincentyDistance(51.5074, -0.1278, -33.8688, 151.2093)
    expect(vDist / 1000).toBeGreaterThan(16000)
    expect(vDist / 1000).toBeLessThan(17500)
  })

  it('handles Accra to Nairobi', () => {
    const distance = vincentyDistance(5.6037, -0.187, -1.2921, 36.8219)
    expect(distance / 1000).toBeCloseTo(4184, -1)
  })
})
