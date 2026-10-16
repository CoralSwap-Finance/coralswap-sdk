# Security Policy

CoralSwap is a decentralized exchange protocol, and the `coralswap-sdk` is used to
build applications that move real financial assets on Stellar/Soroban. We take the
security of the SDK and the wider protocol seriously and appreciate the work of
security researchers in keeping users safe.

Please review this policy before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, discussions, or any other public channel.** Public disclosure of an
unpatched vulnerability puts users' funds at risk.

Instead, report it privately through GitHub's private vulnerability reporting:

1. Go to the repository's **[Security](https://github.com/CoralSwap-Finance/coralswap-sdk/security)** tab.
2. Click **"Report a vulnerability"** to open a private security advisory.
3. Fill in the details (see [What to include](#what-to-include) below).

This channel is private, monitored by the maintainers, and encrypted in transit.

> Maintainers: if the "Report a vulnerability" button is not visible, enable
> **Private vulnerability reporting** under *Settings → Code security and analysis*.
> A dedicated security email and/or PGP key can also be added here if the project
> adopts them.

### What to include

A good report helps us triage faster. Where possible, please include:

- The type of issue (e.g. key handling, transaction construction, input
  validation, dependency vulnerability).
- The affected SDK version(s), file paths, and/or functions.
- Step-by-step instructions to reproduce the issue.
- Proof-of-concept code, if available.
- The potential impact, including how an attacker might exploit it.

## Response Targets (SLA)

We aim to meet the following timelines for valid reports. These are good-faith
targets, not contractual guarantees, and business days are used where noted.

| Stage                         | Target                                  |
| ----------------------------- | --------------------------------------- |
| Acknowledge receipt           | Within **48 hours**                     |
| Initial assessment & severity | Within **5 business days**              |
| Status updates                | At least every **7 days** until resolved |
| Fix / mitigation              | Per the severity table below            |

## Severity Levels & Remediation Targets

Severity is assessed by the maintainers, guided by [CVSS v3.1](https://www.first.org/cvss/calculator/3.1)
and the real-world impact on user funds and protocol integrity.

| Severity     | Description                                                                                          | Target remediation     |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| **Critical** | Direct loss of user funds, key/seed exposure, or signing of unintended transactions.                 | **7 days**             |
| **High**     | Significant impact requiring specific conditions; incorrect transaction parameters, bypassed checks. | **30 days**            |
| **Medium**   | Limited impact or hard-to-exploit issues; information disclosure without direct fund loss.            | **90 days**            |
| **Low**      | Minimal impact; defense-in-depth hardening, edge-case input handling.                                | Best effort            |

## Scope

### In scope

- The `coralswap-sdk` TypeScript package in this repository (`src/`).
- Example code in `examples/` insofar as it demonstrates an insecure pattern the
  SDK encourages.
- How the SDK constructs, signs, and submits Soroban transactions; handles secret
  keys and seeds; validates inputs and on-chain responses; and computes swap,
  liquidity, flash-loan, or oracle parameters.

### Related but potentially separate

- **CoralSwap Soroban smart contracts** and their **on-chain deployments** (mainnet
  and testnet). These may be maintained in separate repositories. If you believe a
  vulnerability lies in the deployed contracts rather than the SDK, **still report
  it privately here** — we will route it to the right maintainers and coordinate.

### Out of scope

- Vulnerabilities in third-party dependencies that are already public — please
  report those upstream (we still welcome a heads-up).
- Issues requiring a compromised end-user device, browser extension, or operating
  system.
- Social engineering, phishing, or physical attacks.
- Reports from automated scanners without a demonstrated, exploitable impact.
- Missing best-practice headers or configuration on third-party websites not
  controlled by this repository.

## Coordinated Disclosure

We follow coordinated disclosure. Once a report is validated, we ask that you give
us a reasonable window — typically up to **90 days**, or sooner once a fix is
released — before any public disclosure, so users can upgrade. We are happy to
credit researchers in the advisory and release notes unless you prefer to remain
anonymous.

## Bug Bounty

There is **no public bug bounty program documented for this project at this time.**
Responsible disclosure is nonetheless greatly appreciated, and we will publicly
credit valid reports. If a bounty program is established, its details and rewards
will be listed in this section.

## Safe Harbor

We consider security research and vulnerability disclosure conducted in good faith
and in accordance with this policy to be authorized. We will not pursue or support
legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  interruption or degradation of services.
- Only interact with accounts they own or have explicit permission to access, and
  use test networks where possible.
- Report promptly and do not exploit a vulnerability beyond what is necessary to
  demonstrate it.

## Supported Versions

Security fixes are applied to the latest released version of the SDK. Users are
strongly encouraged to track the most recent release (see
[CHANGELOG.md](./CHANGELOG.md)) and upgrade promptly when security releases are
published.
