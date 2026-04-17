# @delali/narsil-certutil

CLI tool for generating and managing TLS certificates for Narsil clusters. Handles CA creation, node certificate signing, CSR generation for external CAs, certificate inspection, chain verification, and PEM/PKCS#12 format conversion.

## Installation

```bash
npm install -g @delali/narsil-certutil
```

Or use directly in a project:

```bash
pnpm add -E @delali/narsil-certutil
```

## Quick start

Generate certificates for a three-node Narsil cluster in four commands:

```bash
# 1. Create a Certificate Authority
narsil-certutil ca --name "My Narsil CA" --out-dir ./certs

# 2. Create a cluster config file
cat > cluster.yaml << EOF
nodes:
  - cn: node1
    ip: [10.0.0.1]
    dns: [node1.cluster.local]
  - cn: node2
    ip: [10.0.0.2]
    dns: [node2.cluster.local]
  - cn: node3
    ip: [10.0.0.3]
    dns: [node3.cluster.local]
defaults:
  days: 365
  keySize: 2048
EOF

# 3. Generate all node certificates in one batch
narsil-certutil cert \
  --ca-cert ./certs/ca.crt \
  --ca-key ./certs/ca.key \
  --nodes cluster.yaml \
  --out-dir ./certs/nodes

# 4. Verify each certificate
narsil-certutil verify \
  --cert ./certs/nodes/node1/node1.crt \
  --key ./certs/nodes/node1/node1.key \
  --ca-cert ./certs/ca.crt
```

This produces:

```
certs/
  ca.crt
  ca.key
  nodes/
    node1/
      node1.crt
      node1.key
    node2/
      node2.crt
      node2.key
    node3/
      node3.crt
      node3.key
```

## Commands

### `narsil-certutil ca`

Generate a self-signed Certificate Authority.

```bash
narsil-certutil ca --name "Narsil CA" --out-dir ./certs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--name <name>` | required | CA common name |
| `--days <n>` | 3650 | Validity period in days |
| `--key-size <bits>` | 4096 | RSA key size (2048 or 4096) |
| `--out-dir <dir>` | `.` | Output directory |
| `--output <format>` | text | Output format (text or json) |
| `--force` | false | Overwrite existing files |
| `--dry-run` | false | Preview without writing |

**Output files:** `ca.crt`, `ca.key`

### `narsil-certutil cert`

Generate a node certificate signed by an existing CA. Supports single-node and batch modes.

**Single node:**

```bash
narsil-certutil cert \
  --cn node1 \
  --ca-cert ca.crt \
  --ca-key ca.key \
  --ip 10.0.0.1 \
  --dns node1.cluster.local \
  --out-dir ./certs
```

**Batch mode:**

```bash
narsil-certutil cert \
  --ca-cert ca.crt \
  --ca-key ca.key \
  --nodes cluster.yaml \
  --out-dir ./certs/nodes
```

| Option | Default | Description |
|--------|---------|-------------|
| `--cn <name>` | | Node common name (required for single mode) |
| `--ca-cert <path>` | required | Path to CA certificate |
| `--ca-key <path>` | required | Path to CA private key |
| `--ip <addresses...>` | | IP Subject Alternative Names |
| `--dns <names...>` | | DNS Subject Alternative Names |
| `--days <n>` | 365 | Validity period in days |
| `--key-size <bits>` | 2048 | RSA key size |
| `--out-dir <dir>` | `.` | Output directory |
| `--nodes <path>` | | Cluster YAML/JSON for batch mode |
| `--output <format>` | text | Output format |
| `--force` | false | Overwrite existing files |
| `--dry-run` | false | Preview without writing |

All node certificates include both `serverAuth` and `clientAuth` extended key usage, which is required for Narsil's mutual TLS (mTLS).

**Output files:** `<cn>.crt`, `<cn>.key` (batch mode writes to `<out-dir>/<cn>/`)

### `narsil-certutil csr`

Generate a Certificate Signing Request for organizations that require an external CA.

**Single node:**

```bash
narsil-certutil csr \
  --cn node1 \
  --ip 10.0.0.1 \
  --dns node1.cluster.local \
  --out-dir ./certs
```

**Batch mode:**

```bash
narsil-certutil csr --nodes cluster.yaml --out-dir ./certs/csrs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--cn <name>` | | Common name (required for single mode) |
| `--ip <addresses...>` | | IP SANs |
| `--dns <names...>` | | DNS SANs |
| `--key-size <bits>` | 2048 | RSA key size |
| `--out-dir <dir>` | `.` | Output directory |
| `--nodes <path>` | | Cluster YAML/JSON for batch mode |
| `--output <format>` | text | Output format |
| `--force` | false | Overwrite existing files |
| `--dry-run` | false | Preview without writing |

**Output files:** `<cn>.csr`, `<cn>.key`

**Workflow with an external CA:**

1. Generate CSRs: `narsil-certutil csr --nodes cluster.yaml --out-dir ./csrs`
2. Send `.csr` files to your organization's CA
3. Receive back signed `.crt` files
4. Verify: `narsil-certutil verify --cert node1.crt --key ./csrs/node1/node1.key --ca-cert company-ca.crt`
5. Deploy the `.crt`, `.key`, and CA cert to each node

### `narsil-certutil inspect`

Display details of a PEM-encoded certificate, CSR, or private key.

```bash
narsil-certutil inspect ./certs/node1.crt
```

```
Type:           certificate
Subject:        CN=node1
Issuer:         CN=Narsil CA
Valid from:     2026-04-12T00:00:00Z
Valid until:    2027-04-12T00:00:00Z
Expires in:     364 days
Serial:         a9f3e7...
Key usage:      digitalSignature, keyEncipherment
Ext key usage:  serverAuth, clientAuth
IP SANs:        10.0.0.1
DNS SANs:       node1.cluster.local
Fingerprint:    SHA256:A9:F3:E7:...
Key size:       2048-bit RSA
```

| Option | Default | Description |
|--------|---------|-------------|
| `<file>` | required | Path to PEM file (positional argument) |
| `--output <format>` | text | Output format |

### `narsil-certutil verify`

Verify a certificate's chain, key match, expiry, and mTLS readiness.

```bash
narsil-certutil verify \
  --cert node1.crt \
  --key node1.key \
  --ca-cert ca.crt
```

```
  pass  Certificate matches private key
  pass  Certificate chain validates against CA
  pass  Certificate not expired
  pass  Key usage includes digitalSignature and keyEncipherment
  pass  Ready for Narsil mTLS (serverAuth + clientAuth)
```

You can run partial verification by omitting `--key` or `--ca-cert`:

```bash
# Chain only (no key match check)
narsil-certutil verify --cert node1.crt --ca-cert ca.crt

# Key match only (no chain check)
narsil-certutil verify --cert node1.crt --key node1.key
```

| Option | Default | Description |
|--------|---------|-------------|
| `--cert <path>` | required | Certificate to verify |
| `--key <path>` | | Private key to check match |
| `--ca-cert <path>` | | CA certificate for chain validation |
| `--output <format>` | text | Output format |

Exits with code 1 if any check fails.

### `narsil-certutil convert`

Convert between PEM and PKCS#12 (.p12/.pfx) formats. Useful for interoperability with Java keystores, Windows systems, and load balancers.

**PEM to PKCS#12:**

```bash
narsil-certutil convert \
  --cert node1.crt \
  --key node1.key \
  --ca-cert ca.crt \
  --to p12 \
  --p12-password changeit \
  --out-dir ./certs
```

**PKCS#12 to PEM:**

```bash
narsil-certutil convert \
  --p12 node1.p12 \
  --to pem \
  --p12-password changeit \
  --out-dir ./certs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--cert <path>` | | Certificate PEM (for p12 conversion) |
| `--key <path>` | | Private key PEM (for p12 conversion) |
| `--ca-cert <path>` | | CA cert PEM (included in p12 bundle) |
| `--p12 <path>` | | PKCS#12 input file (for pem conversion) |
| `--to <format>` | required | Target format: `pem` or `p12` |
| `--p12-password <pw>` | | Password for PKCS#12 |
| `--out-dir <dir>` | `.` | Output directory |
| `--output <format>` | text | Output format |
| `--force` | false | Overwrite existing files |

## Cluster config file format

The `--nodes` flag accepts YAML or JSON files. YAML is recommended because it supports comments.

**YAML:**

```yaml
# Production cluster certificate config
nodes:
  - cn: node1
    ip: [10.0.0.1, 192.168.1.1]
    dns: [node1.cluster.local, node1.search.internal]
  - cn: node2
    ip: [10.0.0.2]
    dns: [node2.cluster.local]
  - cn: node3
    ip: [10.0.0.3]
    dns: [node3.cluster.local]

defaults:
  days: 365
  keySize: 2048
```

**JSON equivalent:**

```json
{
  "nodes": [
    { "cn": "node1", "ip": ["10.0.0.1"], "dns": ["node1.cluster.local"] },
    { "cn": "node2", "ip": ["10.0.0.2"], "dns": ["node2.cluster.local"] },
    { "cn": "node3", "ip": ["10.0.0.3"], "dns": ["node3.cluster.local"] }
  ],
  "defaults": {
    "days": 365,
    "keySize": 2048
  }
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `nodes` | yes | Array of node definitions |
| `nodes[].cn` | yes | Common name for the node |
| `nodes[].ip` | no | Array of IP addresses for SANs |
| `nodes[].dns` | no | Array of DNS names for SANs |
| `defaults.days` | no | Default validity period for all nodes |
| `defaults.keySize` | no | Default RSA key size (2048 or 4096) |

## JSON output mode

All commands support `--output json` for machine-readable output. The response uses a consistent envelope:

**Success:**

```json
{
  "status": "success",
  "data": { ... },
  "error": null,
  "metadata": { "duration_ms": 14.2 }
}
```

**Error:**

```json
{
  "status": "error",
  "data": null,
  "error": {
    "code": "BAD_ARGUMENTS",
    "message": "Either --cn or --nodes is required",
    "suggestion": "Provide --cn for single cert or --nodes for batch mode"
  },
  "metadata": { "duration_ms": 0.8 }
}
```

## Environment variables

| Variable | Equivalent flag | Description |
|----------|----------------|-------------|
| `NARSIL_CERT_OUT_DIR` | `--out-dir` | Default output directory |
| `NARSIL_CA_CERT` | `--ca-cert` | Path to CA certificate |
| `NARSIL_CA_KEY` | `--ca-key` | Path to CA private key |
| `NARSIL_P12_PASSWORD` | `--p12-password` | PKCS#12 password |

Flags take precedence over environment variables.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Configuration problem |
| 4 | File not found |
| 5 | Permission denied |
| 10 | Network or timeout failure |

## Certificate rotation workflow

Certificates expire. Here's how to rotate them without cluster downtime:

```bash
# 1. Check current cert expiry
narsil-certutil inspect /etc/narsil/tls/node1.crt --output json

# 2. Generate a new certificate (self-signed CA)
narsil-certutil cert \
  --cn node1 \
  --ca-cert /etc/narsil/tls/ca.crt \
  --ca-key /etc/narsil/tls/ca.key \
  --ip 10.0.0.1 \
  --dns node1.cluster.local \
  --out-dir /tmp/rotation

# Or generate a CSR for external CA
narsil-certutil csr \
  --cn node1 \
  --ip 10.0.0.1 \
  --dns node1.cluster.local \
  --out-dir /tmp/rotation

# 3. Verify the new cert before deploying
narsil-certutil verify \
  --cert /tmp/rotation/node1.crt \
  --key /tmp/rotation/node1.key \
  --ca-cert /etc/narsil/tls/ca.crt

# 4. Deploy (Narsil picks up new certs via file watch or SIGHUP)
cp /tmp/rotation/node1.crt /etc/narsil/tls/node1.crt
cp /tmp/rotation/node1.key /etc/narsil/tls/node1.key
```

## Programmatic API

The crypto functions are available as a library for use in scripts or other tools:

```typescript
import {
  generateCaCertificate,
  generateNodeCertificate,
  generateCsr,
  pemToPkcs12,
  pkcs12ToPem,
  computeFingerprint,
  detectPemType,
  loadClusterConfig,
} from '@delali/narsil-certutil'

const ca = generateCaCertificate({ name: 'My CA', days: 3650, keySize: 4096 })

const node = generateNodeCertificate({
  caCertPem: ca.certPem,
  caKeyPem: ca.keyPem,
  cn: 'node1',
  ipSans: ['10.0.0.1'],
  dnsSans: ['node1.cluster.local'],
  days: 365,
  keySize: 2048,
})
```

## License

Apache-2.0
