import type { GenerationResult, InspectResult, OutputEnvelope, VerifyResult } from '../types'

export function formatJson<T>(envelope: OutputEnvelope<T>): string {
  return JSON.stringify(envelope, null, 2)
}

export function formatSuccess<T>(data: T, startTime: number, json: boolean): string {
  if (!json) {
    return ''
  }
  const envelope: OutputEnvelope<T> = {
    status: 'success',
    data,
    error: null,
    metadata: { duration_ms: performance.now() - startTime },
  }
  return formatJson(envelope)
}

export function formatError(
  code: string,
  message: string,
  suggestion: string | undefined,
  startTime: number,
  json: boolean,
): string {
  if (json) {
    const envelope: OutputEnvelope<null> = {
      status: 'error',
      data: null,
      error: { code, message, suggestion },
      metadata: { duration_ms: performance.now() - startTime },
    }
    return formatJson(envelope)
  }

  let output = `Error: ${message}`
  if (suggestion) {
    output += `\n  ${suggestion}`
  }
  return output
}

function padLabel(label: string, width: number): string {
  return `${label}:`.padEnd(width)
}

export function formatInspectText(result: InspectResult): string {
  const labelWidth = 16
  const lines: string[] = []

  lines.push(`${padLabel('Type', labelWidth)}${result.type}`)

  if (result.subject) {
    const subjectParts = Object.entries(result.subject).map(([k, v]) => `${k}=${v}`)
    lines.push(`${padLabel('Subject', labelWidth)}${subjectParts.join(', ')}`)
  }

  if (result.issuer) {
    const issuerParts = Object.entries(result.issuer).map(([k, v]) => `${k}=${v}`)
    lines.push(`${padLabel('Issuer', labelWidth)}${issuerParts.join(', ')}`)
  }

  if (result.validFrom) {
    lines.push(`${padLabel('Valid from', labelWidth)}${result.validFrom}`)
  }

  if (result.validTo) {
    lines.push(`${padLabel('Valid until', labelWidth)}${result.validTo}`)
  }

  if (result.expiresInDays !== undefined) {
    lines.push(`${padLabel('Expires in', labelWidth)}${result.expiresInDays} days`)
  }

  if (result.serialNumber) {
    lines.push(`${padLabel('Serial', labelWidth)}${result.serialNumber}`)
  }

  if (result.keyUsage && result.keyUsage.length > 0) {
    lines.push(`${padLabel('Key usage', labelWidth)}${result.keyUsage.join(', ')}`)
  }

  if (result.extKeyUsage && result.extKeyUsage.length > 0) {
    lines.push(`${padLabel('Ext key usage', labelWidth)}${result.extKeyUsage.join(', ')}`)
  }

  if (result.ipSans && result.ipSans.length > 0) {
    lines.push(`${padLabel('IP SANs', labelWidth)}${result.ipSans.join(', ')}`)
  }

  if (result.dnsSans && result.dnsSans.length > 0) {
    lines.push(`${padLabel('DNS SANs', labelWidth)}${result.dnsSans.join(', ')}`)
  }

  if (result.fingerprint) {
    lines.push(`${padLabel('Fingerprint', labelWidth)}SHA256:${result.fingerprint}`)
  }

  if (result.publicKeyBits) {
    lines.push(`${padLabel('Key size', labelWidth)}${result.publicKeyBits}-bit RSA`)
  }

  return lines.join('\n')
}

export function formatVerifyText(result: VerifyResult): string {
  const lines: string[] = []

  if (result.certKeyMatch !== null) {
    const label = result.certKeyMatch ? 'pass' : 'FAIL'
    const msg = result.certKeyMatch ? 'Certificate matches private key' : 'Certificate does NOT match private key'
    lines.push(`  ${label}  ${msg}`)
  }

  if (result.chainValid !== null) {
    const label = result.chainValid ? 'pass' : 'FAIL'
    const msg = result.chainValid
      ? 'Certificate chain validates against CA'
      : 'Certificate chain does NOT validate against CA'
    lines.push(`  ${label}  ${msg}`)
  }

  const expiryLabel = result.notExpired ? 'pass' : 'FAIL'
  const expiryMsg = result.notExpired ? 'Certificate not expired' : 'Certificate is expired'
  lines.push(`  ${expiryLabel}  ${expiryMsg}`)

  const kuLabel = result.keyUsageCorrect ? 'pass' : 'FAIL'
  const kuMsg = result.keyUsageCorrect
    ? 'Key usage includes digitalSignature and keyEncipherment'
    : 'Key usage missing required fields'
  lines.push(`  ${kuLabel}  ${kuMsg}`)

  const mtlsLabel = result.mtlsReady ? 'pass' : 'FAIL'
  const mtlsMsg = result.mtlsReady
    ? 'Ready for Narsil mTLS (serverAuth + clientAuth)'
    : 'NOT ready for Narsil mTLS (missing serverAuth or clientAuth)'
  lines.push(`  ${mtlsLabel}  ${mtlsMsg}`)

  return lines.join('\n')
}

const FILE_TYPE_LABELS: Record<string, string> = {
  certificate: 'certificate',
  key: 'key',
  csr: 'csr',
}

export function formatGenerationText(result: GenerationResult): string {
  const lines: string[] = ['Created files:']
  const typeWidth = 14

  for (const file of result.files) {
    const typeLabel = FILE_TYPE_LABELS[file.type] ?? file.type
    lines.push(`  ${typeLabel.padEnd(typeWidth)}${file.path}`)
  }

  if (result.fingerprint) {
    lines.push('')
    lines.push(`${'Fingerprint:'.padEnd(14)}SHA256:${result.fingerprint}`)
  }

  if (result.expiresAt) {
    lines.push(`${'Expires:'.padEnd(14)}${result.expiresAt}`)
  }

  return lines.join('\n')
}
