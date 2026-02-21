# [SMART] Add credential model to Client/Device options

## Labels
`type:feature`, `area:client`, `area:device`, `area:security`, `protocol:smart`, `priority:p0`

## Milestone
`M1-Architecture`

## Depends On
`001-smart-transport-abstraction`

## Problem Statement
SMART/KLAP/AES devices require credentials, but current options do not model authenticated sessions.

## Scope
- Add credential fields to client/device options.
- Support `username/password`.
- Support optional credential hash/token cache.
- Enforce credential redaction in logs/errors.

## Out of Scope
- KLAP/AES handshake implementation.
- Persistent secure storage backend.

## Acceptance Criteria
- Credentials can be set at client or device level.
- Device-level credentials override client defaults.
- Clear validation errors for invalid credential input.
- No plaintext password/credential hash in logs or thrown errors.
- Legacy flows still work without credentials.

## Test Plan
- Unit tests for parsing/precedence/validation.
- Redaction tests for logging-safe payloads.
- Regression tests for legacy behavior.

