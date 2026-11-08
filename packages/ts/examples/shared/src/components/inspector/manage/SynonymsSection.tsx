import type { SynonymRule } from '@delali/narsil'
import { type ChangeEvent, useCallback, useEffect, useState } from 'react'
import { useEngineActions } from '../../../engine-actions'
import { Button } from '../../ui/button'
import { ManageSection } from './ManageSection'
import { useActionRunner } from './use-action-runner'

const ONE_WAY_ARROW = '=>'
const MAX_SYNONYM_LINES = 500

function splitWords(text: string): string[] {
  return text
    .split(',')
    .map(word => word.trim())
    .filter(word => word.length > 0)
}

export function parseSynonymLines(text: string): SynonymRule[] | string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length > MAX_SYNONYM_LINES) return `Keep the set to ${MAX_SYNONYM_LINES} lines or fewer.`
  const rules: SynonymRule[] = []
  for (const line of lines) {
    const arrow = line.indexOf(ONE_WAY_ARROW)
    if (arrow !== -1) {
      const word = line.slice(0, arrow).trim()
      const synonyms = splitWords(line.slice(arrow + ONE_WAY_ARROW.length))
      if (word.length === 0 || synonyms.length === 0)
        return `"${line}" needs a word before ${ONE_WAY_ARROW} and words after it.`
      rules.push({ word, synonyms })
      continue
    }
    const words = splitWords(line)
    if (words.length < 2) return `"${line}" needs at least two words separated by commas.`
    rules.push({ words })
  }
  return rules
}

function formatSynonyms(rules: SynonymRule[]): string {
  return rules
    .map(rule =>
      'words' in rule ? rule.words.join(', ') : `${rule.word} ${ONE_WAY_ARROW} ${rule.synonyms.join(', ')}`,
    )
    .join('\n')
}

export function SynonymsSection({ indexName }: { indexName: string }) {
  const actions = useEngineActions()
  const runner = useActionRunner()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const { run } = runner

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    actions
      .getSynonyms(indexName)
      .then(rules => {
        if (cancelled) return
        setText(formatSynonyms(rules))
        setLoaded(true)
      })
      .catch(err => {
        if (cancelled) return
        setLoaded(true)
        void run('Reading synonyms', () => Promise.reject(err))
      })
    return () => {
      cancelled = true
    }
  }, [actions, indexName, run])

  const handleTextChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
  }, [])

  const handleSave = useCallback(() => {
    void run('Saving synonyms', async () => {
      const rules = parseSynonymLines(text)
      if (typeof rules === 'string') throw new Error(rules)
      await actions.updateSynonyms(indexName, rules)
      actions.onChanged(indexName)
      return `The index searches with ${rules.length} synonym rule${rules.length === 1 ? '' : 's'} from the next query.`
    })
  }, [actions, indexName, run, text])

  return (
    <ManageSection
      title="Synonyms"
      description="Write one rule a line. Words separated by commas match one another, and 'film => movie, picture' widens only the word on the left."
      state={runner.state}
      testId="manage-synonyms"
    >
      <textarea
        aria-label="Synonym rules"
        value={text}
        onChange={handleTextChange}
        disabled={!loaded}
        rows={5}
        spellCheck={false}
        className="w-full rounded-md border bg-card p-2 font-mono text-xs"
      />
      <Button type="button" size="sm" className="mt-2" onClick={handleSave} disabled={!loaded || runner.isRunning}>
        Save synonyms
      </Button>
    </ManageSection>
  )
}
