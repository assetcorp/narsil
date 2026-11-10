import { places } from '../../manifest'
import { Separator } from '../ui/separator'

export function PlacesConfig() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        The places come from Natural Earth, which puts its map data in the public domain. Each place holds a name, a
        region, a country, its populations, its coordinates, and a one-line summary that semantic search compares with
        your query.
      </p>
      <Separator />
      <div className="flex gap-6 text-sm">
        <div>
          <span className="block font-mono text-lg font-semibold">{places.docCount.toLocaleString()}</span>
          <span className="text-xs text-muted-foreground">places</span>
        </div>
        <div>
          <span className="block font-mono text-lg font-semibold">384</span>
          <span className="text-xs text-muted-foreground">numbers in each vector</span>
        </div>
      </div>
    </div>
  )
}
