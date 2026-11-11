import { expect } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { Point } from './oracle'

export const INDEX = 'places'
const PAGE_SIZE = 10_000

export async function indexOfPoints(points: readonly Point[]): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  await narsil.createIndex(INDEX, { schema: { location: 'geopoint' } })
  const inserted = await narsil.insertBatch(
    INDEX,
    points.map((location, position) => ({ id: `p${position}`, location })),
  )
  expect(inserted.failed).toEqual([])
  return narsil
}

export async function matchedIds(
  narsil: Narsil,
  centre: Point,
  radius: number,
  highPrecision: boolean,
): Promise<Set<string>> {
  const found = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await narsil.listDocuments(INDEX, {
      filters: { fields: { location: { radius: { ...centre, distance: radius, unit: 'm', highPrecision } } } },
      limit: PAGE_SIZE,
      cursor,
    })
    for (const document of page.documents) found.add(String(document.id))
    cursor = page.cursor ?? undefined
  } while (cursor !== undefined)
  return found
}

export function wronglyDecided(
  points: readonly Point[],
  found: ReadonlySet<string>,
  inside: (point: Point) => boolean,
): string[] {
  const wrong: string[] = []
  for (const [position, point] of points.entries()) {
    if (found.has(`p${position}`) !== inside(point)) wrong.push(`p${position} ${JSON.stringify(point)}`)
  }
  return wrong
}
