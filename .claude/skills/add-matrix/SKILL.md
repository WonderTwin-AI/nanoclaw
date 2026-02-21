---
name: add-matrix
description: Add Matrix/Element as a channel. Can replace WhatsApp entirely or run alongside it. Supports E2EE via matrix-bot-sdk Rust crypto.
---

# Add Matrix/Element Channel

This skill adds Matrix/Element support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `matrix` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `MATRIX_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a bot account and access token?** If yes, collect it now. If no, we'll create one in Phase 3.

3. **Encryption**: Enable E2EE? (default: yes)
   - Yes → `MATRIX_ENCRYPTION=true` (default)
   - No → `MATRIX_ENCRYPTION=false`

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-matrix
```

This deterministically:
- Adds `src/channels/matrix.ts` (MatrixChannel class implementing Channel interface)
- Adds `src/channels/matrix.test.ts` (40+ unit tests)
- Three-way merges Matrix support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Matrix config into `src/config.ts` (MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ONLY, MATRIX_ENCRYPTION exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `matrix-bot-sdk` npm dependency
- Updates `.env.example` with Matrix environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new matrix tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Matrix Bot Account (if needed)

If the user doesn't have a bot account, tell them:

> I need you to create a Matrix bot account on your homeserver:
>
> **Option A: Using Element (easiest)**
> 1. Open Element and register a new account for the bot (e.g., `@lin:saltwyk.io`)
> 2. Go to **Settings** > **Help & About** > **Access Token** (click to reveal)
> 3. Copy the access token
>
> **Option B: Using Synapse admin API**
> ```bash
> # Register a bot user (if you have admin access)
> curl -X POST "https://matrix.saltwyk.io/_synapse/admin/v2/users/@lin:saltwyk.io" \
>   -H "Authorization: Bearer $ADMIN_TOKEN" \
>   -H "Content-Type: application/json" \
>   -d '{"password": "secure-password", "displayname": "Lin"}'
>
> # Get access token by logging in
> curl -X POST "https://matrix.saltwyk.io/_matrix/client/v3/login" \
>   -H "Content-Type: application/json" \
>   -d '{"type": "m.login.password", "identifier": {"type": "m.id.user", "user": "lin"}, "password": "secure-password"}'
> ```
>
> Save the `access_token` from the response.

Wait for the user to provide the access token.

### Configure environment

Add to `.env`:

```bash
MATRIX_HOMESERVER=https://matrix.saltwyk.io
MATRIX_USER_ID=@lin:saltwyk.io
MATRIX_ENCRYPTION=true
```

**Important:** The access token is a secret. Add it to `data/env/env` (NOT `.env`):

```bash
mkdir -p data/env
echo "MATRIX_ACCESS_TOKEN=syt_..." >> data/env/env
```

The container reads secrets from `data/env/env`, not `.env` directly. The token must be available as `MATRIX_ACCESS_TOKEN` in the process environment.

If they chose to replace WhatsApp:

```bash
echo "MATRIX_ONLY=true" >> .env
```

Sync non-secret config to container environment:

```bash
cp .env data/env/env
# Then add the secret token to data/env/env
echo "MATRIX_ACCESS_TOKEN=syt_..." >> data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Room ID

Tell the user:

> 1. Invite the bot to a Matrix room (it will auto-join)
> 2. Send `!chatid` in the room — it will reply with the room's JID
> 3. The format is `mx:!roomId:server` (e.g., `mx:!azBsCLAWcUNAifggjX:saltwyk.io`)

Wait for the user to provide the room JID.

### Register the room

Use the IPC register flow or register directly. The room JID, name, and folder name are needed.

For a main room (responds to all messages, uses the `main` folder):

```typescript
registerGroup("mx:!roomId:server", {
  name: "<room-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional rooms (trigger-only):

```typescript
registerGroup("mx:!roomId:server", {
  name: "<room-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Matrix room:
> - For main room: Any message works
> - For non-main: `@Lin hello` or mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

### Verify E2EE

If encryption is enabled, check that the message has a shield icon in Element indicating it was sent/received encrypted.

## Troubleshooting

### Bot not responding

1. Check `MATRIX_ACCESS_TOKEN` is set in `data/env/env`
2. Check `MATRIX_HOMESERVER` and `MATRIX_USER_ID` are set in `.env`
3. Check room is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mx:%'"`
4. For non-main rooms: message must include trigger pattern
5. Service is running: `launchctl list | grep nanoclaw`

### Bot not joining rooms

Ensure the bot is invited to the room. The `AutojoinRoomsMixin` handles auto-accepting invites. If the bot was already in the room before NanoClaw started, it should still receive messages.

### E2EE issues

1. Crypto state is stored in `store/matrix-crypto/` — ensure it persists across restarts
2. If you see "unable to decrypt" errors, the crypto state may be corrupted. Stop NanoClaw, delete `store/matrix-crypto/`, restart, and re-verify sessions
3. Make sure `MATRIX_ENCRYPTION=true` is set

### Getting room ID

If `!chatid` doesn't work:
- Verify token: `curl -s "https://matrix.saltwyk.io/_matrix/client/v3/account/whoami" -H "Authorization: Bearer $TOKEN"`
- Check bot is started: `tail -f logs/nanoclaw.log`
- In Element: Room Settings > Advanced > Internal room ID

## After Setup

The Matrix channel is now active. The bot will:
- Auto-join rooms when invited
- Respond to messages in registered rooms
- Show typing indicators while processing
- Handle E2EE transparently (if enabled)
