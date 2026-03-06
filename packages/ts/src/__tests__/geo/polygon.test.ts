import { describe, expect, it } from 'vitest'
import { isPointInPolygon, polygonCentroid } from '../../geo/polygon'

describe('isPointInPolygon', () => {
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 10 },
    { lat: 10, lon: 10 },
    { lat: 10, lon: 0 },
  ]

  it('returns true for a point inside a square', () => {
    expect(isPointInPolygon(5, 5, square)).toBe(true)
  })

  it('returns false for a point outside a square', () => {
    expect(isPointInPolygon(15, 5, square)).toBe(false)
    expect(isPointInPolygon(-1, -1, square)).toBe(false)
  })

  it('returns true for a point near the center', () => {
    expect(isPointInPolygon(5.001, 4.999, square)).toBe(true)
  })

  it('returns false for a point far outside', () => {
    expect(isPointInPolygon(50, 50, square)).toBe(false)
  })

  const triangle = [
    { lat: 0, lon: 0 },
    { lat: 10, lon: 5 },
    { lat: 0, lon: 10 },
  ]

  it('returns true for a point inside a triangle', () => {
    expect(isPointInPolygon(3, 5, triangle)).toBe(true)
  })

  it('returns false for a point outside a triangle', () => {
    expect(isPointInPolygon(8, 2, triangle)).toBe(false)
  })

  it('returns false for a degenerate polygon with fewer than 3 points', () => {
    expect(isPointInPolygon(0, 0, [])).toBe(false)
    expect(isPointInPolygon(0, 0, [{ lat: 0, lon: 0 }])).toBe(false)
    expect(
      isPointInPolygon(0, 0, [
        { lat: 0, lon: 0 },
        { lat: 1, lon: 1 },
      ]),
    ).toBe(false)
  })

  it('works with an irregular polygon', () => {
    const lShape = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 5 },
      { lat: 5, lon: 5 },
      { lat: 5, lon: 3 },
      { lat: 10, lon: 3 },
      { lat: 10, lon: 0 },
    ]
    expect(isPointInPolygon(2, 2, lShape)).toBe(true)
    expect(isPointInPolygon(8, 1, lShape)).toBe(true)
    expect(isPointInPolygon(8, 4, lShape)).toBe(false)
  })

  it('works with real-world coordinates (Greater Accra region)', () => {
    const greaterAccra = [
      { lat: 5.45, lon: -0.35 },
      { lat: 5.45, lon: 0.15 },
      { lat: 5.85, lon: 0.15 },
      { lat: 5.85, lon: -0.35 },
    ]
    expect(isPointInPolygon(5.6037, -0.187, greaterAccra)).toBe(true)
    expect(isPointInPolygon(6.5, 1.0, greaterAccra)).toBe(false)
  })
})

describe('polygonCentroid', () => {
  it('computes the centroid of a square', () => {
    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
      { lat: 10, lon: 10 },
      { lat: 10, lon: 0 },
    ]
    const c = polygonCentroid(square)
    expect(c.lat).toBeCloseTo(5, 5)
    expect(c.lon).toBeCloseTo(5, 5)
  })

  it('computes the centroid of a triangle', () => {
    const triangle = [
      { lat: 0, lon: 0 },
      { lat: 6, lon: 0 },
      { lat: 0, lon: 6 },
    ]
    const c = polygonCentroid(triangle)
    expect(c.lat).toBeCloseTo(2, 5)
    expect(c.lon).toBeCloseTo(2, 5)
  })

  it('computes the centroid of an equilateral triangle', () => {
    const h = Math.sqrt(3) / 2
    const equilateral = [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 0 },
      { lat: 0.5, lon: h },
    ]
    const c = polygonCentroid(equilateral)
    expect(c.lat).toBeCloseTo(0.5, 4)
    expect(c.lon).toBeCloseTo(h / 3, 4)
  })

  it('returns {lat: 0, lon: 0} for a degenerate polygon', () => {
    const c = polygonCentroid([])
    expect(c.lat).toBe(0)
    expect(c.lon).toBe(0)
  })

  it('returns {lat: 0, lon: 0} for a two-point polygon', () => {
    const c = polygonCentroid([
      { lat: 0, lon: 0 },
      { lat: 1, lon: 1 },
    ])
    expect(c.lat).toBe(0)
    expect(c.lon).toBe(0)
  })

  it('falls back to arithmetic mean for collinear points', () => {
    const collinear = [
      { lat: 0, lon: 0 },
      { lat: 5, lon: 0 },
      { lat: 10, lon: 0 },
    ]
    const c = polygonCentroid(collinear)
    expect(c.lat).toBeCloseTo(5, 5)
    expect(c.lon).toBeCloseTo(0, 5)
    expect(Number.isFinite(c.lat)).toBe(true)
    expect(Number.isFinite(c.lon)).toBe(true)
  })

  it('handles a rectangle centered at origin', () => {
    const rect = [
      { lat: -5, lon: -3 },
      { lat: -5, lon: 3 },
      { lat: 5, lon: 3 },
      { lat: 5, lon: -3 },
    ]
    const c = polygonCentroid(rect)
    expect(c.lat).toBeCloseTo(0, 5)
    expect(c.lon).toBeCloseTo(0, 5)
  })
})
