# [SMART] Refactor transport abstraction without behavior change

## Labels
`type:refactor`, `area:network`, `area:client`, `protocol:legacy`, `protocol:smart`, `priority:p0`

## Milestone
`M1-Architecture`

## Problem Statement
Current networking is tightly coupled to legacy TCP/UDP transport paths, making SMART/KLAP/AES support hard to add safely.

## Scope
- Introduce a transport interface usable by `Device` and `Client`.
- Keep existing legacy behavior and public API unchanged.
- Move protocol-specific logic behind adapters.

## Out of Scope
- SMART auth or encryption implementation.
- Command semantic changes.
- Public API breaks.

## Acceptance Criteria
- Existing legacy tests pass unchanged.
- No public API signature changes.
- Legacy discovery and command behavior is preserved.
- Code paths are ready for additional transport implementations.

## Test Plan
- Full existing test suite.
- Unit tests for transport contract behavior with mocked adapters.
- Regression coverage for `Client.send` and `Device.send`.

