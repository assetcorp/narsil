import { type MouseEvent, useCallback, useMemo } from 'react'
import type { MapPlace } from '../../hooks/use-map-places'
import {
  type GeoPoint,
  MAP_HEIGHT,
  MAP_WIDTH,
  type MapShape,
  projectX,
  projectY,
  unproject,
} from '../../lib/geo-shapes'

interface WorldPlotProps {
  places: MapPlace[]
  matchedIds: ReadonlySet<string>
  shape: MapShape
  onPick: (point: GeoPoint) => void
}

const GRATICULE_STEP_DEGREES = 30
const EARTH_RADIUS_KM = 6_371.0088
const CIRCLE_OUTLINE_STEPS = 120
const DEGREES_PER_RADIAN = 180 / Math.PI

const LONGITUDE_LINES = Array.from(
  { length: MAP_WIDTH / GRATICULE_STEP_DEGREES - 1 },
  (_, i) => (i + 1) * GRATICULE_STEP_DEGREES,
)
const LATITUDE_LINES = Array.from(
  { length: MAP_HEIGHT / GRATICULE_STEP_DEGREES - 1 },
  (_, i) => (i + 1) * GRATICULE_STEP_DEGREES,
)

function circleOutline(centre: GeoPoint, distanceKm: number): string {
  const angular = distanceKm / EARTH_RADIUS_KM
  const lat1 = centre.lat / DEGREES_PER_RADIAN
  const lon1 = centre.lon / DEGREES_PER_RADIAN
  const points: string[] = []
  for (let step = 0; step <= CIRCLE_OUTLINE_STEPS; step++) {
    const bearing = (2 * Math.PI * step) / CIRCLE_OUTLINE_STEPS
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing))
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      )
    const lon = ((((lon2 * DEGREES_PER_RADIAN + 180) % 360) + 360) % 360) - 180
    points.push(`${projectX(lon)},${projectY(lat2 * DEGREES_PER_RADIAN)}`)
  }
  return points.join(' ')
}

function ShapeOutline({ shape }: { shape: MapShape }) {
  if (shape.kind === 'radius') {
    return (
      <>
        <polyline
          points={circleOutline(shape.centre, shape.distanceKm)}
          className="fill-none stroke-primary"
          strokeWidth={0.4}
          strokeDasharray="1 1"
        />
        <circle cx={projectX(shape.centre.lon)} cy={projectY(shape.centre.lat)} r={1} className="fill-primary" />
      </>
    )
  }
  if (shape.corners.length === 0) return null
  const points = shape.corners.map(corner => `${projectX(corner.lon)},${projectY(corner.lat)}`).join(' ')
  return (
    <>
      <polygon points={points} className="fill-primary/10 stroke-primary" strokeWidth={0.4} />
      {shape.corners.map(corner => (
        <circle
          key={`${corner.lat}:${corner.lon}`}
          cx={projectX(corner.lon)}
          cy={projectY(corner.lat)}
          r={0.8}
          className="fill-primary"
        />
      ))}
    </>
  )
}

export function WorldPlot({ places, matchedIds, shape, onPick }: WorldPlotProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const box = event.currentTarget.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      const x = ((event.clientX - box.left) / box.width) * MAP_WIDTH
      const y = ((event.clientY - box.top) / box.height) * MAP_HEIGHT
      onPick(unproject(x, y))
    },
    [onPick],
  )

  const dots = useMemo(
    () =>
      places.map(place => (
        <circle
          key={place.id}
          cx={projectX(place.point.lon)}
          cy={projectY(place.point.lat)}
          r={matchedIds.has(place.id) ? 0.9 : 0.5}
          className={matchedIds.has(place.id) ? 'fill-primary' : 'fill-muted-foreground/50'}
        />
      )),
    [places, matchedIds],
  )

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="World map. Click to place the circle centre or a polygon corner."
      data-testid="world-map"
      className="block aspect-2/1 w-full cursor-crosshair overflow-hidden rounded-lg border bg-card p-0"
    >
      <svg
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        preserveAspectRatio="none"
        className="size-full"
        aria-hidden="true"
      >
        {LONGITUDE_LINES.map(x => (
          <line key={`lon-${x}`} x1={x} y1={0} x2={x} y2={MAP_HEIGHT} className="stroke-border" strokeWidth={0.2} />
        ))}
        {LATITUDE_LINES.map(y => (
          <line key={`lat-${y}`} x1={0} y1={y} x2={MAP_WIDTH} y2={y} className="stroke-border" strokeWidth={0.2} />
        ))}
        {dots}
        <ShapeOutline shape={shape} />
      </svg>
    </button>
  )
}
