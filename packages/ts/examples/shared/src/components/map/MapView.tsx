import { Loader2, LocateFixed } from 'lucide-react'
import { type ChangeEvent, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import { type PositionRequest, useCurrentPosition } from '../../hooks/use-current-position'
import type { IndexSchemaView } from '../../hooks/use-index-schema'
import { useMapPlaces } from '../../hooks/use-map-places'
import {
  formatCorner,
  type GeoPoint,
  MAX_RADIUS_KM,
  type MapShape,
  parseCorners,
  shapeFilter,
  validPoint,
} from '../../lib/geo-shapes'
import { useActiveIndex, useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { MatchedPlaces } from './MatchedPlaces'
import { WorldPlot } from './WorldPlot'

type ShapeKind = MapShape['kind']

const DEFAULT_CENTRE: GeoPoint = { lat: 5.6037, lon: -0.187 }
const DEFAULT_DISTANCE_KM = '500'
const LABEL_CANDIDATES = ['name', 'title']

function ShapeButton({
  kind,
  active,
  onSelect,
}: {
  kind: ShapeKind
  active: boolean
  onSelect: (kind: ShapeKind) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(kind)
  }, [onSelect, kind])

  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={handleClick}
    >
      {kind === 'radius' ? 'Within a distance' : 'Inside a polygon'}
    </Button>
  )
}

export function MapView({ schema }: { schema: IndexSchemaView }) {
  const { activeIndexName } = useIndexWorkspace()
  const activeIndex = useActiveIndex()
  const [kind, setKind] = useState<ShapeKind>('radius')
  const [centreLat, setCentreLat] = useState(String(DEFAULT_CENTRE.lat))
  const [centreLon, setCentreLon] = useState(String(DEFAULT_CENTRE.lon))
  const [distance, setDistance] = useState(DEFAULT_DISTANCE_KM)
  const [cornersText, setCornersText] = useState('')
  const centreChosenRef = useRef(false)

  const handlePositionFound = useCallback((point: GeoPoint, request: PositionRequest) => {
    if (request === 'already-allowed' && centreChosenRef.current) return
    centreChosenRef.current = true
    setCentreLat(String(point.lat))
    setCentreLon(String(point.lon))
  }, [])
  const position = useCurrentPosition(handlePositionFound)

  const geoField = useMemo(() => schema.leaves.find(leaf => leaf.type === 'geopoint')?.path ?? null, [schema.leaves])
  const labelField = useMemo(() => {
    const paths = new Set(schema.leaves.map(leaf => leaf.path))
    return LABEL_CANDIDATES.find(candidate => paths.has(candidate)) ?? null
  }, [schema.leaves])

  const corners = useMemo(() => parseCorners(cornersText), [cornersText])
  const shape = useMemo<MapShape>(() => {
    if (kind === 'radius') {
      return { kind, centre: { lat: Number(centreLat), lon: Number(centreLon) }, distanceKm: Number(distance) }
    }
    return { kind, corners: typeof corners === 'string' ? [] : corners }
  }, [kind, centreLat, centreLon, distance, corners])

  const filter = useMemo(() => (geoField === null ? null : shapeFilter(geoField, shape)), [geoField, shape])
  const deferredFilter = useDeferredValue(filter)

  const all = useMapPlaces(activeIndexName, geoField, labelField, null, true)
  const matched = useMapPlaces(activeIndexName, geoField, labelField, deferredFilter, deferredFilter !== null)
  const matchedIds = useMemo(() => new Set(matched.places.map(place => place.id)), [matched.places])

  const handlePick = useCallback(
    (point: GeoPoint) => {
      if (kind === 'radius') {
        centreChosenRef.current = true
        setCentreLat(String(point.lat))
        setCentreLon(String(point.lon))
        return
      }
      setCornersText(current => {
        const line = formatCorner(point)
        const lines = current.split('\n').filter(entry => entry.trim().length > 0)
        if (lines[lines.length - 1]?.trim() === line) return current
        return [...lines, line].join('\n')
      })
    },
    [kind],
  )

  const handleLat = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    centreChosenRef.current = true
    setCentreLat(event.target.value)
  }, [])

  const handleLon = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    centreChosenRef.current = true
    setCentreLon(event.target.value)
  }, [])

  const handleDistance = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDistance(event.target.value)
  }, [])

  const handleCorners = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setCornersText(event.target.value)
  }, [])

  const handleClearCorners = useCallback(() => {
    setCornersText('')
  }, [])

  if (activeIndexName === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Map</h1>
        <p className="text-sm text-muted-foreground">Load World Places from the Datasets tab to search by location.</p>
      </div>
    )
  }

  const problem =
    geoField === null
      ? 'This index declares no geopoint field. Pick the places index above.'
      : filter !== null
        ? null
        : kind === 'polygon'
          ? typeof corners === 'string'
            ? corners
            : 'Add at least three corners.'
          : validPoint(Number(centreLat), Number(centreLon))
            ? `Give a distance above 0 and up to ${MAX_RADIUS_KM.toLocaleString()} km.`
            : 'Give the centre a latitude from -90 to 90 and a longitude from -180 to 180.'

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Map</h1>
        <p className="text-sm text-muted-foreground">
          Find the places in <span className="font-mono font-medium text-foreground">{activeIndex?.name}</span> within a
          distance of a point or inside a polygon. The engine runs the geo filter, and the map draws its answer.
        </p>
      </div>

      <IndexSelector />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShapeButton kind="radius" active={kind === 'radius'} onSelect={setKind} />
        <ShapeButton kind="polygon" active={kind === 'polygon'} onSelect={setKind} />
      </div>

      {kind === 'radius' ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <label htmlFor="map-centre-latitude" className="flex flex-col gap-1.5 text-xs font-medium">
            Centre latitude, in degrees
            <Input
              id="map-centre-latitude"
              value={centreLat}
              onChange={handleLat}
              inputMode="decimal"
              className="h-8 text-xs"
            />
          </label>
          <label htmlFor="map-centre-longitude" className="flex flex-col gap-1.5 text-xs font-medium">
            Centre longitude, in degrees
            <Input
              id="map-centre-longitude"
              value={centreLon}
              onChange={handleLon}
              inputMode="decimal"
              className="h-8 text-xs"
            />
          </label>
          <label htmlFor="map-distance" className="flex flex-col gap-1.5 text-xs font-medium">
            Distance in kilometres
            <Input
              id="map-distance"
              value={distance}
              onChange={handleDistance}
              inputMode="decimal"
              className="h-8 text-xs"
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start sm:col-span-3"
            onClick={position.locate}
            disabled={position.isLocating}
          >
            {position.isLocating ? <Loader2 className="size-3.5 animate-spin" /> : <LocateFixed className="size-3.5" />}
            Use my location
          </Button>
          {position.error === null ? null : <p className="text-xs text-destructive sm:col-span-3">{position.error}</p>}
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          <textarea
            value={cornersText}
            onChange={handleCorners}
            rows={4}
            spellCheck={false}
            aria-label="Polygon corners, one latitude and longitude a line"
            placeholder="Click the map to add corners, or type one latitude and longitude a line"
            className="rounded-md border bg-card p-2 font-mono text-xs"
          />
          <Button type="button" size="xs" variant="outline" className="self-start" onClick={handleClearCorners}>
            Clear corners
          </Button>
        </div>
      )}

      {problem === null ? null : <p className="mb-3 text-xs text-destructive">{problem}</p>}
      {all.error === null ? null : <p className="mb-3 text-xs text-destructive">{all.error}</p>}

      <WorldPlot places={all.places} matchedIds={matchedIds} shape={shape} onPick={handlePick} />

      <MatchedPlaces
        places={matched.places}
        isLoading={matched.isLoading}
        error={matched.error}
        active={deferredFilter !== null}
      />
    </div>
  )
}
