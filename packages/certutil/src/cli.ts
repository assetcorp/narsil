import { Command } from 'commander'
import { registerCaCommand } from './commands/ca'
import { registerCertCommand } from './commands/cert'
import { registerConvertCommand } from './commands/convert'
import { registerCsrCommand } from './commands/csr'
import { registerInspectCommand } from './commands/inspect'
import { registerVerifyCommand } from './commands/verify'

const program = new Command()

program
  .name('narsil-certutil')
  .description('Generate and manage TLS certificates for Narsil clusters')
  .version('0.1.0')
  .addHelpText(
    'after',
    `
Quick start:
  $ narsil-certutil ca --name "Narsil CA" --out-dir ./certs
  $ narsil-certutil cert --cn node1 --ca-cert ./certs/ca.crt --ca-key ./certs/ca.key --ip 10.0.0.1
  $ narsil-certutil verify --cert node1.crt --key node1.key --ca-cert ./certs/ca.crt

Batch mode (generate certs for an entire cluster from a YAML config):
  $ narsil-certutil cert --ca-cert ca.crt --ca-key ca.key --nodes cluster.yaml --out-dir ./certs

Exit codes:
  0   Success
  1   General error
  2   Invalid arguments
  3   Configuration problem
  4   File not found
  5   Permission denied`,
  )

registerCaCommand(program)
registerCertCommand(program)
registerCsrCommand(program)
registerInspectCommand(program)
registerVerifyCommand(program)
registerConvertCommand(program)

program.parse()
