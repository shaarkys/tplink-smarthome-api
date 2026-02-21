# [KLAP] Implement KLAP handshake/login/session lifecycle

## Labels
`type:feature`, `transport:klap`, `area:network`, `area:tests`, `protocol:smart`, `priority:p0`

## Milestone
`M2-KLAP`

## Depends On
- `001-smart-transport-abstraction`
- `002-smart-credentials-model`

## Problem Statement
No KLAP transport currently exists, so authenticated SMART devices cannot establish sessions or execute commands.

## Scope
- Implement KLAP handshake and authenticated session startup.
- Add session lifecycle management (create/reuse/refresh/close).
- Add retry behavior for expired sessions.
- Integrate with transport abstraction.

## Out of Scope
- AES SMART fallback.
- Full SMART module parity.
- Discovery protocol expansion.

## Acceptance Criteria
- Successful login with valid credentials.
- Predictable auth failure for invalid credentials.
- Session reuse across sequential commands.
- Automatic relogin on session expiry.
- Safe behavior under concurrent command calls.
- No credential leakage in logs/errors.

## Test Plan
- Fixture integration tests for:
  - handshake success/failure
  - session expiry + renewal
  - parallel request behavior
  - timeout/retry behavior

