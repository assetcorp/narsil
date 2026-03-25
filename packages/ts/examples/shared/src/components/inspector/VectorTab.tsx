import { useEffect, useMemo, useState } from 'react'
import { loadUmapData, type UmapData } from '../../lib/umap-loader'

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

interface MovieDoc {
  id?: string | number
  title?: string
  genres?: string[]
}

interface VectorTabProps {
  indexName: string
}

export default function VectorTab({ indexName }: VectorTabProps) {
  const [umapData, setUmapData] = useState<UmapData | null>(null)
  const [movies, setMovies] = useState<MovieDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
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
      const rgb = (genre && GENRE_COLORS[genre]) ?? DEFAULT_COLOR
      const hidden = genre ? hiddenGenres.has(genre) : false
      arr[i * 3] = hidden ? 0.15 : rgb[0]
      arr[i * 3 + 1] = hidden ? 0.15 : rgb[1]
      arr[i * 3 + 2] = hidden ? 0.15 : rgb[2]
    }
    return arr
  }, [umapData, movies, movieLookup, hiddenGenres])

  const hoveredMovie = useMemo(() => {
    if (hoveredIndex === null || !umapData) return null
    const id = umapData.ids[hoveredIndex]
    return movieLookup.get(id) ?? null
  }, [hoveredIndex, umapData, movieLookup])

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

  function toggleGenre(genre: string) {
    setHiddenGenres(prev => {
      const next = new Set(prev)
      if (next.has(genre)) {
        next.delete(genre)
      } else {
        next.add(genre)
      }
      return next
    })
  }

  if (typeof window === 'undefined') {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Vector visualization requires a browser environment.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative h-[500px] overflow-hidden rounded-lg border bg-black/95">
        <VectorCanvas positions={umapData.positions} colors={colors} onHover={setHoveredIndex} />
        {hoveredMovie && (
          <div className="pointer-events-none absolute left-4 top-4 max-w-xs rounded-md bg-background/90 px-3 py-2 shadow-lg backdrop-blur-sm">
            <p className="text-sm font-medium">{hoveredMovie.title}</p>
            {hoveredMovie.genres && hoveredMovie.genres.length > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">{hoveredMovie.genres.join(', ')}</p>
            )}
          </div>
        )}
      </div>

      <div>
        <span className="mb-2 block text-xs font-medium">Genre Legend</span>
        <div className="flex flex-wrap gap-1.5">
          {allGenres.map(genre => {
            const rgb = GENRE_COLORS[genre]
            const hidden = hiddenGenres.has(genre)
            return (
              <button
                key={genre}
                type="button"
                onClick={() => toggleGenre(genre)}
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
          })}
        </div>
      </div>
    </div>
  )
}

function VectorCanvas({
  positions,
  colors,
  onHover,
}: {
  positions: Float32Array
  colors: Float32Array
  onHover: (index: number | null) => void
}) {
  const [R3F, setR3F] = useState<{
    Canvas: typeof import('@react-three/fiber').Canvas
    OrbitControls: typeof import('@react-three/drei').OrbitControls
    PointCloud: typeof import('./PointCloud').PointCloud
  } | null>(null)

  useEffect(() => {
    Promise.all([import('@react-three/fiber'), import('@react-three/drei'), import('./PointCloud')]).then(
      ([fiber, drei, pc]) => {
        setR3F({
          Canvas: fiber.Canvas,
          OrbitControls: drei.OrbitControls,
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

  const { Canvas, OrbitControls, PointCloud } = R3F

  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 50 }} className="size-full">
      <ambientLight intensity={0.6} />
      <PointCloud positions={positions} colors={colors} onHover={onHover} />
      <OrbitControls enableDamping dampingFactor={0.12} />
    </Canvas>
  )
}
