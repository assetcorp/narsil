import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTypewriter } from './typing-text'

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useTypewriter', () => {
  it('shows the initial text immediately without animating', () => {
    stubMatchMedia(false)
    const { result } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'Overview of Ghana' },
    })
    expect(result.current).toBe('Overview of Ghana')
  })

  it('types a changed text out character by character', () => {
    vi.useFakeTimers()
    stubMatchMedia(false)
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'First question' },
    })

    act(() => {
      rerender({ text: 'abc' })
    })
    expect(result.current).toBe('')

    act(() => {
      vi.advanceTimersByTime(24)
    })
    expect(result.current).toBe('a')

    act(() => {
      vi.advanceTimersByTime(48)
    })
    expect(result.current).toBe('abc')
  })

  it('stops the previous animation when the text changes again mid-typing', () => {
    vi.useFakeTimers()
    stubMatchMedia(false)
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'start' },
    })

    act(() => {
      rerender({ text: 'abcdef' })
      vi.advanceTimersByTime(48)
    })
    act(() => {
      rerender({ text: 'xy' })
      vi.advanceTimersByTime(48)
    })

    expect(result.current).toBe('xy')
  })

  it('shows changed text at once when reduced motion is preferred', () => {
    vi.useFakeTimers()
    stubMatchMedia(true)
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'First question' },
    })

    act(() => {
      rerender({ text: 'Generated title' })
    })
    expect(result.current).toBe('Generated title')
  })

  it('shows changed text at once when matchMedia is unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', undefined)
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'First question' },
    })

    act(() => {
      rerender({ text: 'Generated title' })
    })
    expect(result.current).toBe('Generated title')
  })
})
