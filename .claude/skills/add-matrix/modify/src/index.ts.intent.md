# Intent: src/index.ts modifications

## What changed
Added Matrix/Element as a channel option alongside the existing WhatsApp channel using the multi-channel architecture.

## Key sections

### Imports (top of file)
- Added: `MatrixChannel` from `./channels/matrix.js`
- Added: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ONLY`, `MATRIX_ENCRYPTION` from `./config.js`
- Added: `findChannel` from `./router.js`
- Added: `Channel` type from `./types.js`

### Module-level state
- Added: `const channels: Channel[] = []` — array of all active channels
- Kept: `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference

### processGroupMessages()
- Added: `findChannel(channels, chatJid)` lookup at the start
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` (optional chaining)
- Changed: `whatsapp.sendMessage()` → `channel.sendMessage()` in output callback

### startMessageLoop()
- Added: `findChannel(channels, chatJid)` lookup per group in message processing
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` for typing indicators

### main()
- Changed: shutdown disconnects all channels via `for (const ch of channels)`
- Added: shared `channelOpts` object for channel callbacks
- Added: conditional WhatsApp creation (`if (!MATRIX_ONLY)`)
- Added: conditional Matrix creation (`if (MATRIX_HOMESERVER && MATRIX_USER_ID)`)
- Changed: scheduler `sendMessage` uses `findChannel()` → `channel.sendMessage()`
- Changed: IPC `sendMessage` uses `findChannel()` → `channel.sendMessage()`

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
