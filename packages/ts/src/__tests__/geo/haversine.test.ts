import { describe, expect, it } from 'vitest'
import { haversineDistance } from '../../geo/haversine'

describe('haversineDistance', () => {
  it('returns 0 for the same point', () => {
    expect(haversineDistance(51.5074, -0.1278, 51.5074, -0.1278)).toBe(0)
  })

  it('computes the distance from London to Paris (~344 km)', () => {
    const distance = haversineDistance(51.5074, -0.1278, 48.8566, 2.3522)
    expect(distance / 1000).toBeCloseTo(343.6, 0)
  })

  it('computes the distance from New York to Los Angeles (~3936 km)', () => {
    const distance = haversineDistance(40.7128, -74.006, 34.0522, -118.2437)
    expect(distance / 1000).toBeCloseTo(3936, 0)
  })

  it('computes the distance from the North Pole to the South Pole', () => {
    const distance = haversineDistance(90, 0, -90, 0)
    const halfCircumference = Math.PI * 6_371_008.8
    expect(distance).toBeCloseTo(halfCircumference, -2)
  })

  it('computes the distance from the equator across 1 degree of longitude', () => {
    const distance = haversineDistance(0, 0, 0, 1)
    const expectedMeters = (2 * Math.PI * 6_371_008.8) / 360
    expect(distance).toBeCloseTo(expectedMeters, 0)
  })

  it('is symmetric: d(A, B) equals d(B, A)', () => {
    const d1 = haversineDistance(51.5074, -0.1278, 48.8566, 2.3522)
    const d2 = haversineDistance(48.8566, 2.3522, 51.5074, -0.1278)
    expect(d1).toBeCloseTo(d2, 5)
  })

  it('handles points crossing the antimeridian', () => {
    const distance = haversineDistance(0, 179, 0, -179)
    const expected = 2 * Math.PI * 6_371_008.8 * (2 / 360)
    expect(distance).toBeCloseTo(expected, 0)
  })

  it('handles Accra (Ghana) to Lagos (Nigeria) (~410 km)', () => {
    const distance = haversineDistance(5.6037, -0.187, 6.5244, 3.3792)
    expect(distance / 1000).toBeCloseTo(410, -1)
  })
})
