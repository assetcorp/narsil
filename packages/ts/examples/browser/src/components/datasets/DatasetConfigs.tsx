import { tmdb, wikipedia } from '@delali/narsil-example-shared'
import { useCallback } from 'react'
import { Button } from '#/components/ui/button'
import { Separator } from '#/components/ui/separator'

function TierButton({ label, active, onSelect }: { label: string; active: boolean; onSelect: (t: string) => void }) {
  const handleClick = useCallback(() => onSelect(label), [label, onSelect])
  return (
    <Button
      type="button"
      variant={active ? 'default' : 'outline'}
      size="sm"
      className="font-mono text-xs"
      onClick={handleClick}
    >
      {label}
    </Button>
  )
}

export function TmdbConfig({ tier, setTier }: { tier: string; setTier: (t: string) => void }) {
  const tiers = tmdb.tiers.map(t => t.label)
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-sm font-medium">Document tier</span>
        <div className="flex flex-wrap gap-2">
          {tiers.map(t => (
            <TierButton key={t} label={t} active={tier === t} onSelect={setTier} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Larger tiers (50k+) are downloaded from GitHub Releases.</p>
      </div>
      <Separator />
      <div>
        <span className="mb-2 block text-sm font-medium">Indexed fields</span>
        <p className="text-xs text-muted-foreground">
          title, overview, tagline, genres, original_language, vote_average, popularity, runtime, revenue, release_year,
          production_countries, status
        </p>
      </div>
    </div>
  )
}

function LangButton({
  code,
  name,
  active,
  onToggle,
}: {
  code: string
  name: string
  active: boolean
  onToggle: (code: string) => void
}) {
  const handleClick = useCallback(() => onToggle(code), [code, onToggle])
  return (
    <Button type="button" variant={active ? 'default' : 'outline'} size="sm" className="text-xs" onClick={handleClick}>
      <span className="font-mono uppercase">{code}</span>
      <span className="ml-1 text-muted-foreground">{name}</span>
    </Button>
  )
}

export function WikiConfig({ selected, toggle }: { selected: Set<string>; toggle: (code: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className="mb-2 block text-sm font-medium">Languages</span>
        <div className="flex flex-wrap gap-2">
          {wikipedia.languages.map(({ code, name }) => (
            <LangButton key={code} code={code} name={name} active={selected.has(code)} onToggle={toggle} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Each language creates its own index with the correct tokenizer.
        </p>
      </div>
      <Separator />
      <div>
        <span className="mb-2 block text-sm font-medium">Text depth</span>
        <p className="text-xs text-muted-foreground">
          Lead section (~2k chars) or full article. Configurable after loading.
        </p>
      </div>
    </div>
  )
}

export function ScifactConfig() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          SciFact is a fixed dataset from the BEIR benchmark: 5,183 scientific paper abstracts, 300 claim queries, and
          expert relevance judgments. No configuration needed.
        </p>
      </div>
      <Separator />
      <div className="flex gap-6 text-sm">
        <div>
          <span className="block font-mono text-lg font-semibold">5,183</span>
          <span className="text-xs text-muted-foreground">documents</span>
        </div>
        <div>
          <span className="block font-mono text-lg font-semibold">300</span>
          <span className="text-xs text-muted-foreground">queries</span>
        </div>
        <div>
          <span className="block font-mono text-lg font-semibold">339</span>
          <span className="text-xs text-muted-foreground">judgments</span>
        </div>
      </div>
    </div>
  )
}
