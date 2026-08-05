<h1 align="center">SMSCode SDKs</h1>

<p align="center">
  <a href="https://github.com/smscode-gg/sdks/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/smscode-gg/sdks/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@smscode/sdk"><img alt="@smscode/sdk on npm" src="https://img.shields.io/npm/v/%40smscode%2Fsdk?label=npm"></a>
  <a href="https://pypi.org/project/smscode/"><img alt="smscode on PyPI" src="https://img.shields.io/pypi/v/smscode?label=PyPI"></a>
  <a href="https://smscode.gg/docs"><img alt="Documentation" src="https://img.shields.io/badge/docs-smscode.gg-6f42c1"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  Official TypeScript, JavaScript, and Python SDKs for the <a href="https://smscode.gg">SMSCode</a> virtual-number API.<br>
  Rent temporary phone numbers, receive OTP/SMS verification codes, and automate phone verification flows.
</p>

## Why SMSCode SDKs

- One public API contract for TypeScript/JavaScript and Python, validated against the same OpenAPI source.
- Money-safe order creation with idempotency keys, typed errors, and retry behavior designed for paid API calls.
- OTP lifecycle helpers for waiting, resending, finishing, capability-gated cancellation, and verifying webhook signatures.
- `/v2` USD-native API by default, with the legacy `/v1` IDR API still available where needed.

## Packages

| Package | Runtime | Registry | Install | Docs |
| --- | --- | --- | --- | --- |
| [`@smscode/sdk`](packages/sdk-js) | TypeScript / JavaScript | [npm](https://www.npmjs.com/package/@smscode/sdk) | `bun add @smscode/sdk` or `npm i @smscode/sdk` | [README](packages/sdk-js/README.md) |
| [`smscode`](packages/sdk-py) | Python 3.10+ | [PyPI](https://pypi.org/project/smscode/) | `pip install smscode` | [README](packages/sdk-py/README.md) |

## Quick Start

### TypeScript / JavaScript

```bash
npm i @smscode/sdk
```

```ts
import { SmscodeClient } from "@smscode/sdk";

const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });
const { balance } = await client.balance.get();

console.log(`USD balance: ${balance.amount}`);
```

### Python

```bash
pip install smscode
```

```py
import os

from smscode import SmscodeClient

with SmscodeClient(token=os.environ["SMSCODE_TOKEN"]) as client:
    balance = client.balance.get()
    print(f"USD balance: {balance.balance.amount}")
```

## Supported Workflows

- Catalog lookup for countries, services, products, and exchange rates.
- Balance reads on `/v2` and `/v1`.
- Order create, list, get, cancel, finish, resend, and active-order lookup.
- OTP polling with code and revision baselines after resend (`afterCode` +
  `afterRevision` / `after_code` + `after_revision`).
- Delivered text/link-only SMS is exposed as `otp_code=null` plus `otp_message`; after a wait timeout, re-read `can_finish`/`can_cancel` before acting.
- Webhook get/update/test plus raw-body signature verification helpers.
- Typed error classes for validation, auth, rate limit, timeout, terminal order, and money/idempotency failures.

## Documentation

- OpenAPI contract (machine-readable): <https://smscode.gg/openapi.yaml>
- AI-agent integration guide: <https://smscode.gg/docs/ai.md>
- Website: <https://smscode.gg>
- GitHub releases: <https://github.com/smscode-gg/sdks/releases>

## Repository Layout

```text
packages/sdk-js/   TypeScript/JavaScript SDK
packages/sdk-py/   Python SDK
docs/              Public API and AI-agent documentation
scripts/           Contract and release verification helpers
```

## License

MIT — see [LICENSE](LICENSE).
