import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface OraclePlace {
  id: string
  name: string
  summary: string
  country: string
  region?: string
  kind: string
  tags: string[]
  population: number
  populations: number[]
  location: { lat: number; lon: number }
}

const placesDirectory = path.resolve(import.meta.dirname, '../../../../../data/processed/places')
const VECTOR_HEADER_BYTES = 8

export function readPlaces(): OraclePlace[] {
  return JSON.parse(readFileSync(path.join(placesDirectory, 'places.json'), 'utf-8')) as OraclePlace[]
}

export function readStoredVectors(): { count: number; dimensions: number; vectorAt: (index: number) => number[] } {
  const bytes = readFileSync(path.join(placesDirectory, 'places-vectors-384.bin'))
  const count = bytes.readUInt32LE(0)
  const dimensions = bytes.readUInt32LE(4)
  return {
    count,
    dimensions,
    vectorAt(index) {
      const values: number[] = []
      const start = VECTOR_HEADER_BYTES + index * dimensions * 4
      for (let i = 0; i < dimensions; i++) values.push(bytes.readFloatLE(start + i * 4))
      return values
    },
  }
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function largestDifference(left: readonly number[], right: readonly number[]): number {
  let largest = 0
  for (let i = 0; i < left.length; i++) largest = Math.max(largest, Math.abs((left[i] ?? 0) - (right[i] ?? 0)))
  return largest
}

export function placeIdsWhere(places: readonly OraclePlace[], test: (place: OraclePlace) => boolean): string[] {
  return places
    .filter(test)
    .map(place => place.id)
    .sort()
}
