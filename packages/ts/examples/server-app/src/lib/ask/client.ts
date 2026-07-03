import type { DatasetId } from '@delali/narsil-example-shared'
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
    'What are some movies about artificial intelligence?',
    'Which movies deal with time travel and its consequences?',
    'What comedies are set in high schools?',
  ],
  wikipedia: [
    'What can you tell me about the history of Ghana?',
    'How is cocoa farmed and processed?',
    'Who are some notable European writers?',
  ],
  scifact: [
    'Does vitamin D supplementation affect bone health?',
    'How does aspirin affect cardiovascular disease risk?',
    'What is the relationship between gut microbiota and obesity?',
  ],
  custom: ['What topics does this dataset cover?', 'Summarize the most common themes in these documents.'],
}

export function suggestionsForDataset(datasetId: DatasetId): string[] {
  return DATASET_SUGGESTIONS[datasetId] ?? DATASET_SUGGESTIONS.custom
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
