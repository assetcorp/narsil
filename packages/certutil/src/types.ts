export interface CaOptions {
  name: string
  days: number
  keySize: 2048 | 4096
}

export interface CertOptions {
  caCertPem: string
  caKeyPem: string
  cn: string
  ipSans: string[]
  dnsSans: string[]
  days: number
  keySize: 2048 | 4096
}

export interface CsrOptions {
  cn: string
  ipSans: string[]
  dnsSans: string[]
  keySize: 2048 | 4096
}

export interface InspectResult {
  type: 'certificate' | 'csr' | 'key'
  subject?: Record<string, string>
  issuer?: Record<string, string>
  validFrom?: string
  validTo?: string
  expiresInDays?: number
  serialNumber?: string
  ipSans?: string[]
  dnsSans?: string[]
  keyUsage?: string[]
  extKeyUsage?: string[]
  fingerprint?: string
  publicKeyBits?: number
}

export interface VerifyResult {
  certKeyMatch: boolean | null
  chainValid: boolean | null
  notExpired: boolean
  keyUsageCorrect: boolean
  mtlsReady: boolean
  errors: string[]
}

export interface ConvertResult {
  format: 'pem' | 'p12'
  files: string[]
}

export interface GenerationResult {
  files: Array<{ path: string; type: 'certificate' | 'key' | 'csr' }>
  fingerprint?: string
  expiresAt?: string
}

export interface BatchNodeSpec {
  cn: string
  ip?: string[]
  dns?: string[]
}

export interface ClusterConfig {
  nodes: BatchNodeSpec[]
  defaults?: {
    days?: number
    keySize?: 2048 | 4096
  }
}

export interface OutputEnvelope<T> {
  status: 'success' | 'error'
  data: T | null
  error: { code: string; message: string; suggestion?: string } | null
  metadata: { duration_ms: number }
}

export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  BAD_ARGUMENTS: 2,
  CONFIG_PROBLEM: 3,
  NOT_FOUND: 4,
  PERMISSION_DENIED: 5,
  NETWORK_ERROR: 10,
} as const
