# Intent: src/config.ts modifications

## What changed
Added configuration exports for Matrix/Element channel support.

## Key sections
- **readEnvFile call**: Must include `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ONLY`, and `MATRIX_ENCRYPTION` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **MATRIX_HOMESERVER**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **MATRIX_USER_ID**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string
- **MATRIX_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation
- **MATRIX_ENCRYPTION**: Boolean flag, defaults to `true` — enables E2EE via matrix-bot-sdk Rust crypto
- **MATRIX_ACCESS_TOKEN**: NOT read here — it's a secret, loaded via `data/env/env` at runtime (same pattern as other secrets)

## Invariants
- All existing config exports remain unchanged
- New Matrix keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Matrix config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
