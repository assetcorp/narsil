import { useMemo } from 'react'
import type { MapPlace } from '../../hooks/use-map-places'

interface MatchedPlacesProps {
  places: MapPlace[]
  isLoading: boolean
  error: string | null
  active: boolean
}

export function MatchedPlaces({ places, isLoading, error, active }: MatchedPlacesProps) {
  const sorted = useMemo(() => [...places].sort((a, b) => a.label.localeCompare(b.label)), [places])

  if (!active) return null

  return (
    <div className="mt-4 rounded-lg border" data-testid="map-matches" aria-busy={isLoading}>
      <div className="border-b px-4 py-2 text-xs font-semibold" data-testid="map-match-count">
        {isLoading ? 'Searching' : `${places.length.toLocaleString()} place${places.length === 1 ? '' : 's'} match`}
      </div>
      {error === null ? null : <p className="px-4 py-2 text-xs text-destructive">{error}</p>}
      {isLoading ? null : (
        <ul className="grid max-h-72 gap-x-4 overflow-auto px-4 py-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map(place => (
            <li key={place.id} data-place-id={place.id} className="truncate">
              {place.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
