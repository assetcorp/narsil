import { type ChangeEvent, useCallback, useState } from 'react'
import { type AnalysisChangeRequest, useEngineActions } from '../../../engine-actions'
import { DEMO_LANGUAGE_NAMES } from '../../../lib/language-names'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

type StopWordChoice = 'keep' | 'language' | 'custom'

const STOP_WORD_CHOICES: Array<{ choice: StopWordChoice; label: string }> = [
  { choice: 'keep', label: 'Keep the current stop words' },
  { choice: 'language', label: "Use the language's stop words" },
  { choice: 'custom', label: 'Use only these stop words' },
]

const MAX_STOP_WORDS = 1_000

function analysisChange(
  language: string,
  current: string,
  choice: StopWordChoice,
  words: string,
): AnalysisChangeRequest | string {
  const change: AnalysisChangeRequest = {}
  if (language !== current) change.language = language
  if (choice === 'language') change.stopWords = null
  if (choice === 'custom') {
    const list = words
      .split(',')
      .map(word => word.trim().toLowerCase())
      .filter(word => word.length > 0)
    if (list.length > MAX_STOP_WORDS) return `List at most ${MAX_STOP_WORDS} stop words.`
    change.stopWords = list
  }
  if (Object.keys(change).length === 0) return 'Pick another language or a stop word change first.'
  return change
}

export function AnalysisSection({ indexName, language }: { indexName: string; language: string }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const [chosenLanguage, setChosenLanguage] = useState(language)
  const [choice, setChoice] = useState<StopWordChoice>('keep')
  const [words, setWords] = useState('')
  const { run } = runner

  const handleStopWords = useCallback((value: string) => {
    setChoice(value as StopWordChoice)
  }, [])

  const handleWordsChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setWords(event.target.value)
  }, [])

  const handleApply = useCallback(() => {
    void run('Reanalysing every document', async () => {
      const change = analysisChange(chosenLanguage, language, choice, words)
      if (typeof change === 'string') throw new Error(change)
      await actions.changeAnalysis(indexName, change)
      actions.onChanged(indexName)
      return 'The index answers with the new analysis.'
    })
  }, [actions, choice, chosenLanguage, indexName, language, run, words])

  return (
    <ManageSection
      title="Analysis"
      description="Change the language or the stop words of the live index. It keeps answering searches while it reanalyses."
      state={runner.state}
      testId="manage-analysis"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={chosenLanguage} onValueChange={setChosenLanguage}>
          <SelectTrigger className="h-8 w-full text-xs" aria-label="Language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEMO_LANGUAGE_NAMES.map(name => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={choice} onValueChange={handleStopWords}>
          <SelectTrigger className="h-8 w-full text-xs" aria-label="Stop words">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STOP_WORD_CHOICES.map(entry => (
              <SelectItem key={entry.choice} value={entry.choice} className="text-xs">
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {choice === 'custom' ? (
        <Input
          value={words}
          onChange={handleWordsChange}
          placeholder="Words separated by commas, or none at all"
          aria-label="Stop word list"
          className="mt-2 h-8 text-xs"
        />
      ) : null}
      <Button type="button" size="sm" className="mt-2" onClick={handleApply} disabled={runner.isRunning}>
        Change analysis
      </Button>
    </ManageSection>
  )
}
