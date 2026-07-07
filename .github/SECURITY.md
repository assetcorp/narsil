# Security policy

## Supported versions

Narsil is pre-1.0 and under active development. Security fixes go into the latest published `0.1.x` release on npm. Upgrade to the latest version before you report a problem, in case a fix already exists.

## Reporting a vulnerability

Report security issues privately through GitHub. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the advisory form](https://github.com/assetcorp/narsil/security/advisories/new). This keeps the report private until a fix is ready.

Please do not open a public issue for a security problem, and please do not disclose it publicly before a fix is deployed.

Include as much as you can:

- The affected version and the runtime, whether Node.js, Bun, Deno, or the browser.
- Which part is affected: the embedded engine, the server, or the distribution layer.
- The steps to reproduce, and a proof of concept if you have one.
- The impact you expect, such as data loss, denial of service, or information disclosure.

## What to expect

You will get an acknowledgement of your report. Once the issue is confirmed, a fix and a coordinated disclosure will follow. The multi-node distribution layer is experimental and not meant for production, so hardening there is still in progress.
