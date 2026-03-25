import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadUmapData, type UmapBounds, type UmapData } from '../../lib/umap-loader'
import { Badge } from '../ui/badge'

const GENRE_COLORS: Record<string, [number, number, number]> = {
  Action: [0.91, 0.3, 0.24],
  Adventure: [0.95, 0.61, 0.07],
  Animation: [0.56, 0.27, 0.68],
  Comedy: [0.18, 0.8, 0.44],
  Crime: [0.2, 0.29, 0.37],
  Documentary: [0.16, 0.5, 0.73],
  Drama: [0.2, 0.6, 0.86],
  Family: [0.95, 0.77, 0.06],
  Fantasy: [0.61, 0.35, 0.71],
  History: [0.55, 0.43, 0.39],
  Horror: [0.15, 0.15, 0.15],
  Music: [0.91, 0.12, 0.39],
  Mystery: [0.35, 0.31, 0.58],
  Romance: [0.94, 0.45, 0.6],
  'Science Fiction': [0.1, 0.74, 0.61],
  'TV Movie': [0.5, 0.55, 0.53],
  Thriller: [0.75, 0.22, 0.17],
  War: [0.44, 0.5, 0.56],
  Western: [0.83, 0.65, 0.37],
}

const DEFAULT_COLOR: [number, number, number] = [0.5, 0.5, 0.5]
const NEIGHBOR_COUNT = 8

interface MovieDoc {
  id?: string | number
  title?: string
  overview?: string
  genres?: string[]
  vote_average?: number
  release_year?: number
}

interface VectorTabProps {
  indexName: string
}

function GenreButton({
  genre,
  rgb,
  hidden,
  onToggle,
}: {
  genre: string
  rgb: [number, number, number]
  hidden: boolean
  onToggle: (genre: string) => void
}) {
  const handleClick = useCallback(() => {
    onToggle(genre)
  }, [onToggle, genre])

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-opacity ${hidden ? 'opacity-40' : 'opacity-100'}`}
    >
      <span
        className="inline-block size-2.5 rounded-full"
        style={{
          backgroundColor: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
        }}
      />
      {genre}
    </button>
  )
}

function findNearestNeighbors(positions: Float32Array, targetIndex: number, count: number): number[] {
  const tx = positions[targetIndex * 3]
  const ty = positions[targetIndex * 3 + 1]
  const tz = positions[targetIndex * 3 + 2]

  const totalPoints = positions.length / 3
  const distances: Array<{ index: number; dist: number }> = []

  for (let i = 0; i < totalPoints; i++) {
    if (i === targetIndex) continue
    const dx = positions[i * 3] - tx
    const dy = positions[i * 3 + 1] - ty
    const dz = positions[i * 3 + 2] - tz
    const dist = dx * dx + dy * dy + dz * dz
    distances.push({ index: i, dist })
  }

  distances.sort((a, b) => a.dist - b.dist)
  return distances.slice(0, count).map(d => d.index)
}

function NeighborItem({ movie, distance }: { movie: MovieDoc; distance: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-white/10 px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-white/90">{movie.title}</p>
        {movie.genres && movie.genres.length > 0 && (
          <p className="truncate text-[10px] text-white/50">{movie.genres.join(', ')}</p>
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] text-white/30">{distance}</span>
    </div>
  )
}

export default function VectorTab({ indexName }: VectorTabProps) {
  const [umapData, setUmapData] = useState<UmapData | null>(null)
  const [movies, setMovies] = useState<MovieDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [hiddenGenres, setHiddenGenres] = useState<Set<string>>(new Set())

  const isTmdb = indexName.startsWith('tmdb-')

  useEffect(() => {
    if (!isTmdb) return

    setLoading(true)
    setError(null)

    Promise.all([
      loadUmapData('/data/processed/tmdb/', 'movies-10000'),
      fetch('/data/processed/tmdb/movies-10000.json').then(r => {
        if (!r.ok) throw new Error(`Failed to load movie data: ${r.status}`)
        return r.json() as Promise<MovieDoc[]>
      }),
    ])
      .then(([umap, movieData]) => {
        setUmapData(umap)
        setMovies(movieData)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setLoading(false))
  }, [isTmdb])

  const movieLookup = useMemo(() => {
    const map = new Map<string, MovieDoc>()
    for (const m of movies) {
      if (m.id !== undefined) map.set(String(m.id), m)
    }
    return map
  }, [movies])

  const colors = useMemo(() => {
    if (!umapData || movies.length === 0) return null

    const arr = new Float32Array(umapData.count * 3)
    for (let i = 0; i < umapData.count; i++) {
      const id = umapData.ids[i]
      const movie = movieLookup.get(id)
      const genre = movie?.genres?.[0]
      const rgb: [number, number, number] = (genre ? GENRE_COLORS[genre] : undefined) ?? DEFAULT_COLOR
      const hidden = genre ? hiddenGenres.has(genre) : false
      arr[i * 3] = hidden ? 0.15 : rgb[0]
      arr[i * 3 + 1] = hidden ? 0.15 : rgb[1]
      arr[i * 3 + 2] = hidden ? 0.15 : rgb[2]
    }
    return arr
  }, [umapData, movies, movieLookup, hiddenGenres])

  const neighborIndices = useMemo(() => {
    if (selectedIndex === null || !umapData) return []
    return findNearestNeighbors(umapData.positions, selectedIndex, NEIGHBOR_COUNT)
  }, [selectedIndex, umapData])

  const hoveredMovie = useMemo(() => {
    if (hoveredIndex === null || !umapData) return null
    const id = umapData.ids[hoveredIndex]
    return movieLookup.get(id) ?? null
  }, [hoveredIndex, umapData, movieLookup])

  const selectedMovie = useMemo(() => {
    if (selectedIndex === null || !umapData) return null
    const id = umapData.ids[selectedIndex]
    return movieLookup.get(id) ?? null
  }, [selectedIndex, umapData, movieLookup])

  const neighborMovies = useMemo(() => {
    if (!umapData || neighborIndices.length === 0 || selectedIndex === null) return []
    return neighborIndices.map(ni => {
      const id = umapData.ids[ni]
      const movie = movieLookup.get(id)
      const sx = umapData.positions[selectedIndex * 3]
      const sy = umapData.positions[selectedIndex * 3 + 1]
      const sz = umapData.positions[selectedIndex * 3 + 2]
      const dx = umapData.positions[ni * 3] - sx
      const dy = umapData.positions[ni * 3 + 1] - sy
      const dz = umapData.positions[ni * 3 + 2] - sz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      return { index: ni, movie: movie ?? { title: id }, distance: dist.toFixed(3) }
    })
  }, [umapData, neighborIndices, selectedIndex, movieLookup])

  const preventPageScroll = useCallback((e: React.WheelEvent) => {
    e.stopPropagation()
  }, [])

  const toggleGenre = useCallback((genre: string) => {
    setHiddenGenres(prev => {
      const next = new Set(prev)
      if (next.has(genre)) {
        next.delete(genre)
      } else {
        next.add(genre)
      }
      return next
    })
  }, [])

  const handlePointClick = useCallback((index: number | null) => {
    setSelectedIndex(prev => (prev === index ? null : index))
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedIndex(null)
  }, [])

  if (!isTmdb) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Vector visualization is available for the TMDB 10k dataset. Load it from the Datasets tab to explore the
        embedding space.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Loading vector embeddings and UMAP projection...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (!umapData || !colors) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">No vector data available for this index.</div>
    )
  }

  const allGenres = Object.keys(GENRE_COLORS)

  if (typeof window === 'undefined') {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Vector visualization requires a browser environment.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-4">
        <div
          className="relative min-w-0 flex-1 cursor-grab overflow-hidden rounded-lg border bg-black/95 active:cursor-grabbing"
          style={{ height: 540 }}
          onWheel={preventPageScroll}
        >
          <VectorCanvas
            positions={umapData.positions}
            colors={colors}
            bounds={umapData.bounds}
            selectedIndex={selectedIndex}
            neighborIndices={neighborIndices}
            onHover={setHoveredIndex}
            onClick={handlePointClick}
          />
          {hoveredMovie && selectedIndex === null && (
            <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-md bg-black/80 px-3 py-2 shadow-lg backdrop-blur-sm">
              <p className="text-xs font-medium text-white/90">{hoveredMovie.title}</p>
              {hoveredMovie.genres && hoveredMovie.genres.length > 0 && (
                <p className="mt-0.5 text-[10px] text-white/50">{hoveredMovie.genres.join(', ')}</p>
              )}
            </div>
          )}
          <div className="pointer-events-none absolute right-3 bottom-3 flex gap-3 text-[10px] text-white/30">
            <span>Drag to pan</span>
            <span>Scroll to zoom</span>
            <span>Right-drag to rotate</span>
            <span>Click a point to select</span>
          </div>
        </div>

        {selectedMovie && (
          <div className="w-64 shrink-0 overflow-y-auto rounded-lg border bg-black/95 p-3">
            <div className="mb-3 flex items-start justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-white/60">Selected</h4>
              <button
                type="button"
                onClick={handleClearSelection}
                className="text-[10px] text-white/40 hover:text-white/70"
              >
                Clear
              </button>
            </div>

            <div className="mb-4">
              <p className="text-sm font-medium text-white">{selectedMovie.title}</p>
              {selectedMovie.genres && selectedMovie.genres.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {selectedMovie.genres.map(g => (
                    <Badge key={g} variant="outline" className="border-white/20 text-[9px] text-white/70">
                      {g}
                    </Badge>
                  ))}
                </div>
              )}
              {selectedMovie.vote_average !== undefined && selectedMovie.vote_average > 0 && (
                <p className="mt-1 text-[10px] text-white/40">
                  {selectedMovie.vote_average.toFixed(1)}/10
                  {selectedMovie.release_year ? ` \u00b7 ${selectedMovie.release_year}` : ''}
                </p>
              )}
              {selectedMovie.overview && (
                <p className="mt-2 line-clamp-4 text-[11px] leading-relaxed text-white/50">{selectedMovie.overview}</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">
                Nearest Neighbors ({neighborMovies.length})
              </h4>
              <div className="flex flex-col gap-1.5">
                {neighborMovies.map(({ index, movie, distance }) => (
                  <NeighborItem key={index} movie={movie} distance={distance} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <span className="mb-2 block text-xs font-medium">Genre Legend</span>
        <div className="flex flex-wrap gap-1.5">
          {allGenres.map(genre => {
            const rgb = GENRE_COLORS[genre]
            const hidden = hiddenGenres.has(genre)
            return <GenreButton key={genre} genre={genre} rgb={rgb} hidden={hidden} onToggle={toggleGenre} />
          })}
        </div>
      </div>
    </div>
  )
}

function VectorCanvas({
  positions,
  colors,
  bounds,
  selectedIndex,
  neighborIndices,
  onHover,
  onClick,
}: {
  positions: Float32Array
  colors: Float32Array
  bounds: UmapBounds
  selectedIndex: number | null
  neighborIndices: number[]
  onHover: (index: number | null) => void
  onClick: (index: number | null) => void
}) {
  const [R3F, setR3F] = useState<{
    Canvas: typeof import('@react-three/fiber').Canvas
    MapControls: typeof import('@react-three/drei').MapControls
    PointCloud: typeof import('./PointCloud').PointCloud
  } | null>(null)

  useEffect(() => {
    Promise.all([import('@react-three/fiber'), import('@react-three/drei'), import('./PointCloud')]).then(
      ([fiber, drei, pc]) => {
        setR3F({
          Canvas: fiber.Canvas,
          MapControls: drei.MapControls,
          PointCloud: pc.PointCloud,
        })
      },
    )
  }, [])

  if (!R3F) {
    return (
      <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
        Loading 3D renderer...
      </div>
    )
  }

  const { Canvas, MapControls, PointCloud } = R3F
  const [cx, cy, cz] = bounds.center
  const camDistance = bounds.radius * 2.5

  return (
    <Canvas
      camera={{ position: [cx, cy, cz + camDistance], fov: 50, near: 0.001, far: camDistance * 10 }}
      className="size-full"
      style={{ touchAction: 'none' }}
      frameloop="always"
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[cx + 5, cy + 8, cz + 10]} intensity={0.8} />
      <directionalLight position={[cx - 3, cy - 2, cz - 5]} intensity={0.3} />
      <PointCloud
        positions={positions}
        colors={colors}
        selectedIndex={selectedIndex}
        neighborIndices={neighborIndices}
        onHover={onHover}
        onClick={onClick}
      />
      <MapControls
        enableDamping
        dampingFactor={0.15}
        target={[cx, cy, cz]}
        minDistance={bounds.radius * 0.01}
        maxDistance={camDistance * 3}
        zoomSpeed={0.6}
        panSpeed={1.0}
        rotateSpeed={0.5}
      />
    </Canvas>
  )
}
