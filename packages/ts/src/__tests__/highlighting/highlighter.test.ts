import { describe, expect, it } from 'vitest'
import { highlightField } from '../../highlighting/highlighter'
import { english } from '../../languages/english'

describe('highlightField', () => {
  it('highlights a single match in short text', () => {
    const result = highlightField('The quick brown fox', [{ token: 'fox', position: 0 }], english)

    expect(result.snippet).toBe('The quick brown <mark>fox</mark>')
    expect(result.positions).toEqual([{ start: 16, end: 19 }])
  })

  it('highlights multiple matches', () => {
    const result = highlightField(
      'The cat sat on the mat',
      [
        { token: 'cat', position: 0 },
        { token: 'mat', position: 1 },
      ],
      english,
    )

    expect(result.snippet).toBe('The <mark>cat</mark> sat on the <mark>mat</mark>')
    expect(result.positions).toHaveLength(2)
    expect(result.positions[0]).toEqual({ start: 4, end: 7 })
    expect(result.positions[1]).toEqual({ start: 19, end: 22 })
  })

  it('merges overlapping matches', () => {
    const result = highlightField(
      'sunflower seeds grow',
      [
        { token: 'sunflower', position: 0 },
        { token: 'sunflow', position: 1 },
      ],
      english,
    )

    expect(result.positions).toHaveLength(1)
    expect(result.positions[0]).toEqual({ start: 0, end: 9 })
    expect(result.snippet).toContain('<mark>sunflower</mark>')
  })

  it('uses custom tags', () => {
    const result = highlightField('The quick brown fox', [{ token: 'quick', position: 0 }], english, {
      preTag: '**',
      postTag: '**',
    })

    expect(result.snippet).toBe('The **quick** brown fox')
  })

  it('extracts snippet with ellipsis when maxSnippetLength is set', () => {
    const longText =
      'The quick brown fox jumped over the lazy dog and then ran across the open field to find shelter from the rain that was falling heavily on the ground all around the forest clearing where animals gathered'
    const result = highlightField(longText, [{ token: 'shelter', position: 0 }], english, { maxSnippetLength: 50 })

    expect(result.snippet).toContain('...')
    expect(result.snippet).toContain('<mark>')
    expect(result.snippet).toContain('</mark>')
    expect(result.snippet.replace(/<\/?mark>/g, '').replace(/\.\.\./g, '').length).toBeLessThanOrEqual(50)
  })

  it('handles unicode text', () => {
    const result = highlightField('Le cafe est magnifique', [{ token: 'cafe', position: 0 }], english)

    expect(result.snippet).toBe('Le <mark>cafe</mark> est magnifique')
    expect(result.positions).toEqual([{ start: 3, end: 7 }])
  })

  it('returns original text when no matches are found', () => {
    const result = highlightField('The quick brown fox', [{ token: 'zebra', position: 0 }], english)

    expect(result.snippet).toBe('The quick brown fox')
    expect(result.positions).toEqual([])
  })

  it('returns empty snippet for empty text', () => {
    const result = highlightField('', [{ token: 'test', position: 0 }], english)

    expect(result.snippet).toBe('')
    expect(result.positions).toEqual([])
  })

  it('returns original text with empty query tokens', () => {
    const result = highlightField('The quick brown fox', [], english)

    expect(result.snippet).toBe('The quick brown fox')
    expect(result.positions).toEqual([])
  })

  it('handles text with special characters', () => {
    const result = highlightField(
      'Price is $100 (discounted!) for the widget',
      [{ token: 'widget', position: 0 }],
      english,
    )

    expect(result.snippet).toContain('<mark>widget</mark>')
    expect(result.positions).toHaveLength(1)
  })

  it('truncates long text with snippet when no matches found', () => {
    const longText = 'A'.repeat(300)
    const result = highlightField(longText, [{ token: 'zebra', position: 0 }], english, { maxSnippetLength: 50 })

    expect(result.snippet).toContain('...')
    expect(result.positions).toEqual([])
  })

  it('returns full text highlighted when maxSnippetLength is 0', () => {
    const text = 'The fox ran fast and the fox jumped high over the fence near the fox den'
    const result = highlightField(text, [{ token: 'fox', position: 0 }], english, { maxSnippetLength: 0 })

    expect(result.snippet).not.toContain('...')
    const markCount = (result.snippet.match(/<mark>/g) || []).length
    expect(markCount).toBe(3)
    expect(result.positions).toHaveLength(3)
  })

  it('matches stemmed forms of query tokens against field tokens', () => {
    const result = highlightField('The cats are running quickly', [{ token: 'running', position: 0 }], english)

    expect(result.snippet).toContain('<mark>running</mark>')
    expect(result.positions).toHaveLength(1)
  })

  it('matches query stem against different word forms in the text', () => {
    const result = highlightField('She runs every morning', [{ token: 'running', position: 0 }], english)

    expect(result.snippet).toContain('<mark>runs</mark>')
    expect(result.positions).toHaveLength(1)
  })

  it('preserves case from original text in highlighted output', () => {
    const result = highlightField('The Quick Brown Fox', [{ token: 'quick', position: 0 }], english)

    expect(result.snippet).toBe('The <mark>Quick</mark> Brown Fox')
  })
})
