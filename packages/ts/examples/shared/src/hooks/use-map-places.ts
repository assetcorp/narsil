import type { FilterExpression, ListParams } from '@delali/narsil'
import { useEffect, useState } from 'react'
import { type GeoPoint, isGeoPoint } from '../lib/geo-shapes'
import { type ListRunner, useListRunner } from '../query-runner'

export interface MapPlace {
  id: string
  label: string
  point: GeoPoint
}

export const MAP_PAGE_SIZE = 500
export const MAX_MAP_PLACES = 5_000

interface MapPlacesState {
  places: MapPlace[]
  isLoading: boolean
  error: string | null
}

async function readPlaces(
  list: ListRunner,
  indexName: string,
  geoField: string,
  labelField: string | null,
  filters: FilterExpression | null,
  signal: AbortSignal,
): Promise<MapPlace[]> {
  const include = labelField === null ? [geoField] : [geoField, labelField]
  const places: MapPlace[] = []
  let cursor: string | undefined
  do {
    const params: ListParams = { limit: MAP_PAGE_SIZE, document: { include } }
    if (cursor !== undefined) params.cursor = cursor
    if (filters !== null) params.filters = filters
    const page = await list(indexName, params, signal)
    for (const entry of page.documents) {
      const document = entry.document as Record<string, unknown>
      const point = document[geoField]
      if (!isGeoPoint(point)) continue
      const label = labelField === null ? entry.id : String(document[labelField] ?? entry.id)
      places.push({ id: entry.id, label, point: { lat: point.lat, lon: point.lon } })
    }
    cursor = page.cursor ?? undefined
  } while (cursor !== undefined && places.length < MAX_MAP_PLACES && !signal.aborted)
  return places
}

const LOADING: MapPlacesState = { places: [], isLoading: true, error: null }
const IDLE: MapPlacesState = { places: [], isLoading: false, error: null }

export function useMapPlaces(
  indexName: string | null,
  geoField: string | null,
  labelField: string | null,
  filters: FilterExpression | null,
  enabled: boolean,
): MapPlacesState {
  const list = useListRunner()
  const [state, setState] = useState<MapPlacesState>(IDLE)

  useEffect(() => {
    if (!enabled || indexName === null || geoField === null) {
      setState(IDLE)
      return
    }
    const controller = new AbortController()
    setState(LOADING)
    readPlaces(list, indexName, geoField, labelField, filters, controller.signal)
      .then(places => {
        if (!controller.signal.aborted) setState({ places, isLoading: false, error: null })
      })
      .catch(err => {
        if (controller.signal.aborted) return
        setState({ places: [], isLoading: false, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
    }
  }, [list, indexName, geoField, labelField, filters, enabled])

  return state
}
