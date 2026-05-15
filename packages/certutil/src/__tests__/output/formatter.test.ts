import {
  formatError,
  formatGenerationText,
  formatInspectText,
  formatJson,
  formatSuccess,
  formatVerifyText,
} from '../../output/formatter'
import type { GenerationResult, InspectResult, OutputEnvelope, VerifyResult } from '../../types'

describe('formatJson', () => {
  it('produces valid JSON with correct envelope structure', () => {
    const envelope: OutputEnvelope<{ count: number }> = {
      status: 'success',
      data: { count: 42 },
      error: null,
      metadata: { duration_ms: 150 },
    }
    const output = formatJson(envelope)
    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('success')
    expect(parsed.data.count).toBe(42)
    expect(parsed.error).toBeNull()
    expect(parsed.metadata.duration_ms).toBe(150)
  })

  it('formats error envelope with all fields', () => {
    const envelope: OutputEnvelope<null> = {
      status: 'error',
      data: null,
      error: { code: 'NOT_FOUND', message: 'File not found', suggestion: 'Check the path' },
      metadata: { duration_ms: 5 },
    }
    const output = formatJson(envelope)
    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('error')
    expect(parsed.data).toBeNull()
    expect(parsed.error.code).toBe('NOT_FOUND')
    expect(parsed.error.suggestion).toBe('Check the path')
  })

  it('pretty-prints with indentation', () => {
    const envelope: OutputEnvelope<string> = {
      status: 'success',
      data: 'test',
      error: null,
      metadata: { duration_ms: 0 },
    }
    const output = formatJson(envelope)
    expect(output).toContain('\n')
    expect(output).toContain('  ')
  })
})

describe('formatSuccess', () => {
  it('wraps data in envelope when json is true', () => {
    const startTime = performance.now() - 100
    const output = formatSuccess({ name: 'test' }, startTime, true)
    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('success')
    expect(parsed.data.name).toBe('test')
    expect(parsed.error).toBeNull()
    expect(parsed.metadata.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('returns empty string when json is false', () => {
    const output = formatSuccess({ name: 'test' }, performance.now(), false)
    expect(output).toBe('')
  })
})

describe('formatError', () => {
  it('produces JSON envelope when json is true', () => {
    const startTime = performance.now() - 50
    const output = formatError('BAD_ARGS', 'Invalid key size', 'Use 2048 or 4096', startTime, true)
    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('error')
    expect(parsed.data).toBeNull()
    expect(parsed.error.code).toBe('BAD_ARGS')
    expect(parsed.error.message).toBe('Invalid key size')
    expect(parsed.error.suggestion).toBe('Use 2048 or 4096')
  })

  it('produces readable text when json is false', () => {
    const output = formatError('BAD_ARGS', 'Invalid key size', 'Use 2048 or 4096', performance.now(), false)
    expect(output).toContain('Error: Invalid key size')
    expect(output).toContain('Use 2048 or 4096')
  })

  it('omits suggestion line when suggestion is undefined in text mode', () => {
    const output = formatError('GENERAL', 'Something failed', undefined, performance.now(), false)
    expect(output).toBe('Error: Something failed')
  })

  it('includes suggestion as undefined in JSON when not provided', () => {
    const output = formatError('GENERAL', 'fail', undefined, performance.now(), true)
    const parsed = JSON.parse(output)
    expect(parsed.error.suggestion).toBeUndefined()
  })
})

describe('formatInspectText', () => {
  it('displays all fields in aligned format', () => {
    const result: InspectResult = {
      type: 'certificate',
      subject: { CN: 'node1' },
      issuer: { CN: 'Narsil CA' },
      validFrom: '2026-04-12T00:00:00Z',
      validTo: '2027-04-12T00:00:00Z',
      expiresInDays: 365,
      serialNumber: 'a9f3e7001122',
      keyUsage: ['digitalSignature', 'keyEncipherment'],
      extKeyUsage: ['serverAuth', 'clientAuth'],
      ipSans: ['10.0.0.1'],
      dnsSans: ['node1.cluster.local'],
      fingerprint: 'A9:F3:E7:00:11:22',
      publicKeyBits: 2048,
    }
    const output = formatInspectText(result)

    expect(output).toContain('Type:')
    expect(output).toContain('certificate')
    expect(output).toContain('Subject:')
    expect(output).toContain('CN=node1')
    expect(output).toContain('Issuer:')
    expect(output).toContain('CN=Narsil CA')
    expect(output).toContain('Valid from:')
    expect(output).toContain('Valid until:')
    expect(output).toContain('Expires in:')
    expect(output).toContain('365 days')
    expect(output).toContain('Serial:')
    expect(output).toContain('Key usage:')
    expect(output).toContain('digitalSignature')
    expect(output).toContain('Ext key usage:')
    expect(output).toContain('serverAuth')
    expect(output).toContain('IP SANs:')
    expect(output).toContain('10.0.0.1')
    expect(output).toContain('DNS SANs:')
    expect(output).toContain('node1.cluster.local')
    expect(output).toContain('Fingerprint:')
    expect(output).toContain('SHA256:')
    expect(output).toContain('Key size:')
    expect(output).toContain('2048-bit RSA')
  })

  it('omits optional fields when not present', () => {
    const result: InspectResult = {
      type: 'key',
      publicKeyBits: 4096,
    }
    const output = formatInspectText(result)
    expect(output).toContain('Type:')
    expect(output).toContain('key')
    expect(output).toContain('4096-bit RSA')
    expect(output).not.toContain('Subject:')
    expect(output).not.toContain('Issuer:')
    expect(output).not.toContain('Valid from:')
  })

  it('handles CSR type', () => {
    const result: InspectResult = {
      type: 'csr',
      subject: { CN: 'test-node' },
    }
    const output = formatInspectText(result)
    expect(output).toContain('csr')
    expect(output).toContain('CN=test-node')
  })
})

describe('formatVerifyText', () => {
  it('shows pass markers for all passing checks', () => {
    const result: VerifyResult = {
      certKeyMatch: true,
      chainValid: true,
      notExpired: true,
      keyUsageCorrect: true,
      mtlsReady: true,
      errors: [],
    }
    const output = formatVerifyText(result)
    const lines = output.split('\n')
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(line).toContain('pass')
    }
    expect(output).toContain('Certificate matches private key')
    expect(output).toContain('Certificate chain validates against CA')
    expect(output).toContain('Certificate not expired')
    expect(output).toContain('digitalSignature and keyEncipherment')
    expect(output).toContain('Ready for Narsil mTLS')
  })

  it('shows FAIL markers for failing checks', () => {
    const result: VerifyResult = {
      certKeyMatch: false,
      chainValid: false,
      notExpired: false,
      keyUsageCorrect: false,
      mtlsReady: false,
      errors: ['Key mismatch'],
    }
    const output = formatVerifyText(result)
    const lines = output.split('\n')
    for (const line of lines) {
      expect(line).toContain('FAIL')
    }
    expect(output).toContain('does NOT match')
    expect(output).toContain('does NOT validate')
    expect(output).toContain('is expired')
    expect(output).toContain('missing required')
    expect(output).toContain('NOT ready')
  })

  it('skips certKeyMatch and chainValid when null', () => {
    const result: VerifyResult = {
      certKeyMatch: null,
      chainValid: null,
      notExpired: true,
      keyUsageCorrect: true,
      mtlsReady: true,
      errors: [],
    }
    const output = formatVerifyText(result)
    expect(output).not.toContain('private key')
    expect(output).not.toContain('chain')
    const lines = output.split('\n')
    expect(lines).toHaveLength(3)
  })
})

describe('formatGenerationText', () => {
  it('lists created files with type labels', () => {
    const result: GenerationResult = {
      files: [
        { path: '/certs/node1.crt', type: 'certificate' },
        { path: '/certs/node1.key', type: 'key' },
      ],
      fingerprint: 'A9:F3:E7',
      expiresAt: '2027-04-12T00:00:00Z',
    }
    const output = formatGenerationText(result)
    expect(output).toContain('Created files:')
    expect(output).toContain('certificate')
    expect(output).toContain('/certs/node1.crt')
    expect(output).toContain('key')
    expect(output).toContain('/certs/node1.key')
    expect(output).toContain('Fingerprint:')
    expect(output).toContain('SHA256:A9:F3:E7')
    expect(output).toContain('Expires:')
    expect(output).toContain('2027-04-12T00:00:00Z')
  })

  it('omits fingerprint and expiry when not present', () => {
    const result: GenerationResult = {
      files: [{ path: '/certs/node1.csr', type: 'csr' }],
    }
    const output = formatGenerationText(result)
    expect(output).toContain('Created files:')
    expect(output).toContain('csr')
    expect(output).not.toContain('Fingerprint:')
    expect(output).not.toContain('Expires:')
  })
})
