import type { Lease } from 'etcd3'
import type { RegistrationLease } from '../types'

interface LeaseValidity {
  heldUntil: number
  ttlMs: number
}

const MILLISECONDS_PER_SECOND = 1_000

const validities = new WeakMap<Lease, LeaseValidity>()

export function recordLeaseRenewal(lease: Lease, sentAt: number, ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return
  const ttlMs = ttlSeconds * MILLISECONDS_PER_SECOND
  const heldUntil = sentAt + ttlMs
  const current = validities.get(lease)
  if (current !== undefined && current.heldUntil >= heldUntil) return
  validities.set(lease, { heldUntil, ttlMs })
}

export function followLeaseRenewals(lease: Lease): void {
  const unanswered: number[] = []
  lease.on('keepaliveFired', () => {
    unanswered.push(performance.now())
  })
  lease.on('keepaliveSucceeded', response => {
    const sentAt = unanswered.shift()
    if (sentAt !== undefined) recordLeaseRenewal(lease, sentAt, Number(response.TTL))
  })
  lease.on('keepaliveEstablished', () => {
    unanswered.length = 0
  })
  lease.on('keepaliveFailed', () => {
    unanswered.length = 0
  })
  lease.once('lost', () => {
    validities.delete(lease)
  })
}

export function leaseHeldFor(lease: Lease): RegistrationLease | null {
  const validity = validities.get(lease)
  if (validity === undefined || lease.revoked()) return null
  return { remainingMs: validity.heldUntil - performance.now(), ttlMs: validity.ttlMs }
}
