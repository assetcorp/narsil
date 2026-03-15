import { describe, expect, it } from 'vitest'
import { createRequestId, isValidWorkerAction, isValidWorkerResponse } from '../../workers/protocol'

describe('protocol', () => {
  describe('createRequestId', () => {
    it('returns a non-empty string', () => {
      const id = createRequestId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('returns unique values on successive calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(createRequestId())
      }
      expect(ids.size).toBe(100)
    })
  })

  describe('isValidWorkerAction', () => {
    const allTypes = [
      'insert',
      'remove',
      'update',
      'query',
      'preflight',
      'get',
      'has',
      'count',
      'createIndex',
      'dropIndex',
      'getStats',
      'clear',
      'serialize',
      'deserialize',
      'memoryReport',
      'shutdown',
    ] as const

    for (const actionType of allTypes) {
      it(`accepts a valid "${actionType}" action`, () => {
        const msg = { type: actionType, requestId: 'req-123' }
        expect(isValidWorkerAction(msg)).toBe(true)
      })
    }

    it('rejects null', () => {
      expect(isValidWorkerAction(null)).toBe(false)
    })

    it('rejects undefined', () => {
      expect(isValidWorkerAction(undefined)).toBe(false)
    })

    it('rejects a non-object value', () => {
      expect(isValidWorkerAction('insert')).toBe(false)
      expect(isValidWorkerAction(42)).toBe(false)
      expect(isValidWorkerAction(true)).toBe(false)
    })

    it('rejects an object missing the type field', () => {
      expect(isValidWorkerAction({ requestId: 'req-1' })).toBe(false)
    })

    it('rejects an object missing the requestId field', () => {
      expect(isValidWorkerAction({ type: 'insert' })).toBe(false)
    })

    it('rejects an unknown action type', () => {
      expect(isValidWorkerAction({ type: 'explode', requestId: 'req-1' })).toBe(false)
    })

    it('rejects when type is not a string', () => {
      expect(isValidWorkerAction({ type: 123, requestId: 'req-1' })).toBe(false)
    })

    it('rejects when requestId is not a string', () => {
      expect(isValidWorkerAction({ type: 'insert', requestId: 999 })).toBe(false)
    })
  })

  describe('isValidWorkerResponse', () => {
    it('accepts a success response', () => {
      expect(isValidWorkerResponse({ type: 'success', requestId: 'req-1', data: { count: 5 } })).toBe(true)
    })

    it('accepts an error response', () => {
      expect(
        isValidWorkerResponse({ type: 'error', requestId: 'req-2', code: 'INDEX_NOT_FOUND', message: 'not found' }),
      ).toBe(true)
    })

    it('rejects null', () => {
      expect(isValidWorkerResponse(null)).toBe(false)
    })

    it('rejects undefined', () => {
      expect(isValidWorkerResponse(undefined)).toBe(false)
    })

    it('rejects a non-object value', () => {
      expect(isValidWorkerResponse('success')).toBe(false)
    })

    it('rejects a response missing the type field', () => {
      expect(isValidWorkerResponse({ requestId: 'req-1' })).toBe(false)
    })

    it('rejects a response with an invalid type', () => {
      expect(isValidWorkerResponse({ type: 'pending', requestId: 'req-1' })).toBe(false)
    })

    it('rejects a response missing the requestId field', () => {
      expect(isValidWorkerResponse({ type: 'success', data: {} })).toBe(false)
    })

    it('rejects when requestId is not a string', () => {
      expect(isValidWorkerResponse({ type: 'success', requestId: 42, data: {} })).toBe(false)
    })
  })
})
