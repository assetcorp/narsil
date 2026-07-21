import type { LoadedIndex } from '@delali/narsil-example-shared'
import { MessagesSquare } from 'lucide-react'
import { Suggestion } from '#/components/ai-elements/suggestion'
import { suggestionsForIndex } from '#/lib/ask/client'

interface HeroHeadingProps {
  index: LoadedIndex
}

export function HeroHeading({ index }: HeroHeadingProps) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
        <MessagesSquare className="size-6 text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="font-serif text-3xl tracking-tight text-balance sm:text-4xl">Ask {index.name}</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
          Answers come only from the {index.documentCount.toLocaleString()} documents in this index, with the retrieved
          passages shown beside every answer. Switch retrieval modes to watch the same question pull different evidence.
        </p>
      </div>
    </div>
  )
}

interface HeroSuggestionsProps {
  index: LoadedIndex
  disabled: boolean
  onSuggestion: (text: string) => void
}

export function HeroSuggestions({ index, disabled, onSuggestion }: HeroSuggestionsProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {suggestionsForIndex(index).map(text => (
        <Suggestion
          key={text}
          suggestion={text}
          onClick={onSuggestion}
          disabled={disabled}
          className="h-auto whitespace-normal py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
        />
      ))}
    </div>
  )
}
