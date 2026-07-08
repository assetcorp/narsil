import type { DatasetId, LoadedIndex } from '@delali/narsil-example-shared'
import type { AskSourcesData, AskUIMessage, RetrievalMode } from './types'

export interface RetrievalModeOption {
  id: RetrievalMode
  label: string
  description: string
}

export const RETRIEVAL_MODE_OPTIONS: RetrievalModeOption[] = [
  { id: 'keyword', label: 'Keyword', description: 'BM25 term matching. Works on every index.' },
  { id: 'semantic', label: 'Semantic', description: 'Vector similarity over document embeddings.' },
  { id: 'hybrid', label: 'Hybrid', description: 'Keyword and vector results fused with reciprocal rank fusion.' },
]

const DATASET_SUGGESTIONS: Record<DatasetId, string[]> = {
  tmdb: [
    'What are some science fiction movies in this collection?',
    'Recommend a few well-known thriller movies.',
    'What animated films would be good for a family movie night?',
  ],
  wikipedia: [
    'What led to the American Civil War?',
    'Who is Batman, and how was the character created?',
    'What can you tell me about the history of China?',
  ],
  scifact: [
    'Does vitamin D supplementation affect bone health?',
    'How does aspirin affect cardiovascular disease risk?',
    'What is the relationship between gut microbiota and obesity?',
  ],
  custom: ['What topics does this dataset cover?', 'Summarize the most common themes in these documents.'],
}

/**
 * Every Wikipedia edition loads as a single `wikipedia` dataset with the
 * language in the index name (`wikipedia-<code>`), so the starter questions are
 * keyed by that code. Each set names topics that actually appear among the
 * longest articles in that edition's corpus and is phrased in that language, so
 * a chip always has a grounded answer. Editions without an entry fall back to
 * the English set via the `wikipedia` dataset default above.
 */
const WIKIPEDIA_SUGGESTIONS: Record<string, string[]> = {
  en: DATASET_SUGGESTIONS.wikipedia,
  fr: [
    "Que s'est-il passé pendant la Première Guerre mondiale ?",
    'Qui était Léonard de Vinci ?',
    "Quelles furent les causes de la guerre d'Algérie ?",
  ],
  sw: [
    'Malaria husababishwa na nini?',
    'Ukimwi ni nini na huambukizwaje?',
    'Unaweza kuniambia nini kuhusu nchi ya Kenya?',
  ],
  ha: ['Wanene Thomas Sankara?', 'Menene Microsoft?', 'Wanene Ben Affleck?'],
  ig: ['Onye bụ Fela Kuti?', 'Onye bụ John Obi Mikel?', 'Gịnị ka ị maara gbasara Naịjịrịa?'],
  yo: ['Ta ni Cristiano Ronaldo?', 'Kí ni Tẹ́lískópù Òfurufú Hubble?', 'Kí ni èdè Esperanto?'],
  zu: ['Ungangitshela ngoNelson Mandela?', 'Ubani uShaka?', 'Yini i-anime?'],
  tw: ['Ɛdeɛn ne teknɔlɔgyi?', 'Ɛdeɛn ne ɔmanba (citizenship)?', 'Kyerɛkyerɛ me Kɔmputa so nkitahodie ho.'],
  ee: ['Ame ka nye Ousmane Sembène?', 'Ame ka nye Ephraim Amu?', 'Nu ka nye Yoga?'],
  dag: ['Bo n-nyɛ Palmyra?', 'Bo n-nyɛ Nahu Suurili?', 'Bo n-nyɛ Tampion Taarihi?'],
}

function wikipediaLanguageCode(indexName: string): string | null {
  const prefix = 'wikipedia-'
  return indexName.startsWith(prefix) ? indexName.slice(prefix.length) : null
}

export function suggestionsForIndex(index: LoadedIndex): string[] {
  if (index.datasetId === 'wikipedia') {
    const code = wikipediaLanguageCode(index.name)
    if (code) return WIKIPEDIA_SUGGESTIONS[code] ?? DATASET_SUGGESTIONS.wikipedia
  }
  return DATASET_SUGGESTIONS[index.datasetId] ?? DATASET_SUGGESTIONS.custom
}

export function sourcesPartOf(message: AskUIMessage): AskSourcesData | null {
  for (const part of message.parts) {
    if (part.type === 'data-ask-sources') return part.data
  }
  return null
}

export function textOf(message: AskUIMessage): string {
  let text = ''
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text
  }
  return text
}
