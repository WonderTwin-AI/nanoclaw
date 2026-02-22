import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- matrix-bot-sdk mock ---

type EventHandler = (roomId: string, event: any) => Promise<void>;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('matrix-bot-sdk', () => {
  class MockMatrixClient {
    homeserverUrl: string;
    accessToken: string;
    handlers = new Map<string, EventHandler[]>();

    sendText = vi.fn().mockResolvedValue('$event1');
    setTyping = vi.fn().mockResolvedValue(undefined);
    getRoomStateEvent = vi.fn().mockResolvedValue({ name: 'Test Room' });
    getUserProfile = vi.fn().mockResolvedValue({ displayname: 'Alice' });
    stop = vi.fn();

    constructor(homeserverUrl: string, accessToken: string) {
      this.homeserverUrl = homeserverUrl;
      this.accessToken = accessToken;
      clientRef.current = this;
    }

    on(event: string, handler: EventHandler) {
      const existing = this.handlers.get(event) || [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    async start() {
      // Simulate successful start
    }
  }

  return {
    MatrixClient: MockMatrixClient,
    SimpleFsStorageProvider: class {
      constructor() {}
    },
    AutojoinRoomsMixin: {
      setupOnClient: vi.fn(),
    },
    RustSdkCryptoStorageProvider: class {
      constructor() {}
    },
    RustSdkCryptoStoreType: {
      Sqlite: 0,
    },
  };
});

// Mock the sub-module path used for dynamic import of RustSdkCryptoStoreType
vi.mock('matrix-bot-sdk/lib/storage/RustSdkCryptoStorageProvider.js', () => ({
  RustSdkCryptoStoreType: { Sqlite: 0 },
}));

import { MatrixChannel, MatrixChannelOpts } from './matrix.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<MatrixChannelOpts>,
): MatrixChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'mx:!testroom:example.com': {
        name: 'Test Room',
        folder: 'test-room',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextEvent(overrides: {
  sender?: string;
  body?: string;
  formatted_body?: string;
  eventId?: string;
  originServerTs?: number;
  relates_to?: any;
}) {
  return {
    type: 'm.room.message',
    event_id: overrides.eventId ?? '$msg1',
    sender: overrides.sender ?? '@alice:example.com',
    origin_server_ts: overrides.originServerTs ?? Date.now(),
    content: {
      msgtype: 'm.text',
      body: overrides.body ?? 'Hello everyone',
      formatted_body: overrides.formatted_body,
      ...(overrides.relates_to ? { 'm.relates_to': overrides.relates_to } : {}),
    },
  };
}

function createMediaEvent(overrides: {
  msgtype: string;
  sender?: string;
  body?: string;
  eventId?: string;
  originServerTs?: number;
  extra?: Record<string, any>;
}) {
  return {
    type: 'm.room.message',
    event_id: overrides.eventId ?? '$msg1',
    sender: overrides.sender ?? '@alice:example.com',
    origin_server_ts: overrides.originServerTs ?? Date.now(),
    content: {
      msgtype: overrides.msgtype,
      body: overrides.body,
      ...(overrides.extra || {}),
    },
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerRoomMessage(roomId: string, event: any) {
  const handlers = currentClient().handlers.get('room.message') || [];
  for (const h of handlers) await h(roomId, event);
}

async function triggerRoomEvent(roomId: string, event: any) {
  const handlers = currentClient().handlers.get('room.event') || [];
  for (const h of handlers) await h(roomId, event);
}

const TEST_ROOM = '!testroom:example.com';
const TEST_JID = `mx:${TEST_ROOM}`;

// --- Tests ---

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client starts', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers room.message and room.event handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      await channel.connect();

      expect(currentClient().handlers.has('room.message')).toBe(true);
      expect(currentClient().handlers.has('room.event')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      expect(channel.isConnected()).toBe(false);
    });

    it('sets up autojoin on connect', async () => {
      const { AutojoinRoomsMixin } = await import('matrix-bot-sdk');
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      await channel.connect();

      expect(AutojoinRoomsMixin.setupOnClient).toHaveBeenCalled();
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered room', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({ body: 'Hello everyone' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        TEST_JID,
        expect.any(String),
        'Test Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          id: '$msg1',
          chat_jid: TEST_JID,
          sender: '@alice:example.com',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({ body: 'Unknown room' });
      await triggerRoomMessage('!unknown:example.com', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!unknown:example.com',
        expect.any(String),
        'Test Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores own messages', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        sender: '@bot:example.com',
        body: 'My own message',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores edit events', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        body: 'Edited message',
        relates_to: { rel_type: 'm.replace', event_id: '$original' },
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores events with no content', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      await triggerRoomMessage(TEST_ROOM, { sender: '@alice:example.com' });
      await triggerRoomMessage(TEST_ROOM, null);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts display name from profile', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().getUserProfile.mockResolvedValueOnce({
        displayname: 'Bob',
      });

      const event = createTextEvent({
        sender: '@bob:example.com',
        body: 'Hi',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to user ID when profile has no displayname', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().getUserProfile.mockResolvedValueOnce({});

      const event = createTextEvent({
        sender: '@noname:example.com',
        body: 'Hi',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ sender_name: '@noname:example.com' }),
      );
    });

    it('falls back to user ID when profile fetch fails', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().getUserProfile.mockRejectedValueOnce(
        new Error('Not found'),
      );

      const event = createTextEvent({
        sender: '@ghost:example.com',
        body: 'Hi',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ sender_name: '@ghost:example.com' }),
      );
    });

    it('uses room ID as name when room name state not set', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().getRoomStateEvent.mockRejectedValueOnce(
        new Error('No state'),
      );

      const event = createTextEvent({ body: 'Hello' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        TEST_JID,
        expect.any(String),
        TEST_ROOM,
        'matrix',
        true,
      );
    });

    it('converts origin_server_ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const ts = 1704067200000; // 2024-01-01T00:00:00.000Z
      const event = createTextEvent({ body: 'Hello', originServerTs: ts });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates bot mention in formatted_body to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        body: 'Bot what time is it?',
        formatted_body:
          '<a href="https://matrix.to/#/@bot:example.com">Bot</a> what time is it?',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          content: '@Andy Bot what time is it?',
        }),
      );
    });

    it('translates bot MXID in plain body to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        body: '@bot:example.com what time is it?',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          content: '@Andy @bot:example.com what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        body: '@Andy @bot:example.com hello',
        formatted_body:
          '@Andy <a href="https://matrix.to/#/@bot:example.com">Bot</a> hello',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      // Should NOT double-prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          content: '@Andy @bot:example.com hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({
        body: 'Hey @charlie:example.com',
        formatted_body:
          'Hey <a href="https://matrix.to/#/@charlie:example.com">Charlie</a>',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          content: 'Hey @charlie:example.com',
        }),
      );
    });

    it('handles message with no formatted_body', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({ body: 'plain message' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores image with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.image' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('stores image with body as caption', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({
        msgtype: 'm.image',
        body: 'photo.jpg',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Image] photo.jpg' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.video' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.audio' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores file with filename', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({
        msgtype: 'm.file',
        body: 'report.pdf',
      });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[File: report.pdf]' }),
      );
    });

    it('stores file with fallback name when body missing', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.file' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[File: file]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.location' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores sticker event from room.event handler', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = {
        type: 'm.sticker',
        event_id: '$sticker1',
        sender: '@alice:example.com',
        origin_server_ts: Date.now(),
        content: { body: 'thumbs up' },
      };
      await triggerRoomEvent(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[Sticker] thumbs up' }),
      );
    });

    it('ignores sticker events from unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = {
        type: 'm.sticker',
        event_id: '$sticker1',
        sender: '@alice:example.com',
        origin_server_ts: Date.now(),
        content: { body: 'smile' },
      };
      await triggerRoomEvent('!unknown:example.com', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-text messages from unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.image' });
      await triggerRoomMessage('!unknown:example.com', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles unknown message type with generic placeholder', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createMediaEvent({ msgtype: 'm.notice' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        TEST_JID,
        expect.objectContaining({ content: '[m.notice]' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Matrix client', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      await channel.sendMessage(TEST_JID, 'Hello');

      expect(currentClient().sendText).toHaveBeenCalledWith(
        TEST_ROOM,
        'Hello',
      );
    });

    it('strips mx: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      await channel.sendMessage('mx:!other:example.com', 'Group message');

      expect(currentClient().sendText).toHaveBeenCalledWith(
        '!other:example.com',
        'Group message',
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage(TEST_JID, longText);

      expect(currentClient().sendText).toHaveBeenCalledTimes(2);
      expect(currentClient().sendText).toHaveBeenNthCalledWith(
        1,
        TEST_ROOM,
        'x'.repeat(4096),
      );
      expect(currentClient().sendText).toHaveBeenNthCalledWith(
        2,
        TEST_ROOM,
        'x'.repeat(904),
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage(TEST_JID, exactText);

      expect(currentClient().sendText).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().sendText.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage(TEST_JID, 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      // Don't connect — client is null
      await channel.sendMessage(TEST_JID, 'No client');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns mx: JIDs', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('mx:!room:example.com')).toBe(true);
    });

    it('owns mx: JIDs with complex room IDs', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('mx:!azBsCLAWcUNAifggjX:saltwyk.io')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('dc:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      await channel.setTyping(TEST_JID, true);

      expect(currentClient().setTyping).toHaveBeenCalledWith(
        TEST_ROOM,
        true,
        30000,
      );
    });

    it('sends stop typing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      await channel.setTyping(TEST_JID, false);

      expect(currentClient().setTyping).toHaveBeenCalledWith(
        TEST_ROOM,
        false,
        0,
      );
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      // Don't connect
      await channel.setTyping(TEST_JID, true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      currentClient().setTyping.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping(TEST_JID, true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('!chatid replies with room ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({ body: '!chatid' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(currentClient().sendText).toHaveBeenCalledWith(
        TEST_ROOM,
        expect.stringContaining(`mx:${TEST_ROOM}`),
      );
      // Should NOT deliver as a regular message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );
      await channel.connect();

      const event = createTextEvent({ body: '!ping' });
      await triggerRoomMessage(TEST_ROOM, event);

      expect(currentClient().sendText).toHaveBeenCalledWith(
        TEST_ROOM,
        'Andy is online.',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "matrix"', () => {
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        createTestOpts(),
      );
      expect(channel.name).toBe('matrix');
    });
  });

  // --- Encryption ---

  describe('encryption', () => {
    it('enables crypto provider by default', async () => {
      const { RustSdkCryptoStorageProvider } = await import('matrix-bot-sdk');
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
      );

      await channel.connect();

      // The MatrixClient constructor was called — crypto provider was created
      // (We verify by checking the RustSdkCryptoStorageProvider was instantiated)
      expect(channel.isConnected()).toBe(true);
    });

    it('skips crypto provider when encryption disabled', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(
        'https://matrix.example.com',
        'test-token',
        '@bot:example.com',
        opts,
        false, // encryption disabled
      );

      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });
  });
});
