import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  RustSdkCryptoStorageProvider,
} from 'matrix-bot-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: MatrixClient | null = null;
  private opts: MatrixChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;
  private userId: string;
  private encryption: boolean;
  private connected = false;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    userId: string,
    opts: MatrixChannelOpts,
    encryption = true,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.userId = userId;
    this.opts = opts;
    this.encryption = encryption;
  }

  async connect(): Promise<void> {
    const storage = new SimpleFsStorageProvider('store/matrix-bot.json');

    let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
    if (this.encryption) {
      // RustSdkCryptoStoreType.Sqlite = 0, imported from sub-module to avoid
      // top-level ESM re-export issues with matrix-bot-sdk
      const { RustSdkCryptoStoreType } = await import('matrix-bot-sdk/lib/storage/RustSdkCryptoStorageProvider.js');
      cryptoProvider = new RustSdkCryptoStorageProvider('store/matrix-crypto', RustSdkCryptoStoreType.Sqlite);
    }

    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storage,
      cryptoProvider,
    );

    AutojoinRoomsMixin.setupOnClient(this.client);

    // Handle room messages
    this.client.on('room.message', async (roomId: string, event: any) => {
      if (!event?.content) return;

      // Ignore own messages
      if (event.sender === this.userId) return;

      // Ignore edits — they have an m.relates_to with rel_type m.replace
      if (event.content?.['m.relates_to']?.rel_type === 'm.replace') return;

      const chatJid = `mx:${roomId}`;
      const timestamp = new Date(event.origin_server_ts).toISOString();
      const senderName = await this.getDisplayName(roomId, event.sender);
      const msgType = event.content.msgtype;

      // Determine room name
      let roomName: string | undefined;
      try {
        const roomState = await this.client!.getRoomStateEvent(roomId, 'm.room.name', '');
        roomName = roomState?.name;
      } catch {
        // No room name set — use room ID
      }

      // Store chat metadata for discovery (always a group in Matrix)
      this.opts.onChatMetadata(chatJid, timestamp, roomName || roomId, 'matrix', true);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, roomName },
          'Message from unregistered Matrix room',
        );
        return;
      }

      let content: string;

      if (msgType === 'm.text') {
        content = event.content.body || '';

        // Handle !chatid command
        if (content.trim() === '!chatid') {
          await this.client!.sendText(
            roomId,
            `Chat ID: mx:${roomId}\nName: ${roomName || roomId}\nType: room`,
          );
          return;
        }

        // Handle !ping command
        if (content.trim() === '!ping') {
          await this.client!.sendText(roomId, `${ASSISTANT_NAME} is online.`);
          return;
        }

        // Translate Matrix mentions (@user:server) into trigger pattern format.
        // Matrix mentions in body appear as display name, but formatted_body
        // contains the actual MXID. Check if the bot is mentioned.
        const formattedBody = event.content.formatted_body || '';
        const isBotMentioned =
          formattedBody.includes(this.userId) ||
          content.includes(this.userId);

        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      } else if (msgType === 'm.image') {
        content = `[Image]${event.content.body ? ` ${event.content.body}` : ''}`;
      } else if (msgType === 'm.video') {
        content = `[Video]${event.content.body ? ` ${event.content.body}` : ''}`;
      } else if (msgType === 'm.audio') {
        content = `[Audio]${event.content.body ? ` ${event.content.body}` : ''}`;
      } else if (msgType === 'm.file') {
        const fileName = event.content.body || 'file';
        content = `[File: ${fileName}]`;
      } else if (msgType === 'm.location') {
        content = '[Location]';
      } else if (msgType === 'm.sticker' || event.type === 'm.sticker') {
        content = `[Sticker]${event.content.body ? ` ${event.content.body}` : ''}`;
      } else {
        // Unknown message type — store a generic placeholder
        content = `[${msgType || 'Unknown'}]`;
      }

      this.opts.onMessage(chatJid, {
        id: event.event_id,
        chat_jid: chatJid,
        sender: event.sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, roomName, sender: senderName },
        'Matrix message stored',
      );
    });

    // Handle sticker events (separate event type in Matrix)
    this.client.on('room.event', async (roomId: string, event: any) => {
      if (event.type !== 'm.sticker') return;
      if (event.sender === this.userId) return;

      const chatJid = `mx:${roomId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(event.origin_server_ts).toISOString();
      const senderName = await this.getDisplayName(roomId, event.sender);

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'matrix', true);

      this.opts.onMessage(chatJid, {
        id: event.event_id,
        chat_jid: chatJid,
        sender: event.sender,
        sender_name: senderName,
        content: `[Sticker]${event.content?.body ? ` ${event.content.body}` : ''}`,
        timestamp,
        is_from_me: false,
      });
    });

    await this.client.start();
    this.connected = true;

    logger.info(
      { userId: this.userId, homeserver: this.homeserverUrl },
      'Matrix client connected',
    );
    console.log(`\n  Matrix bot: ${this.userId}`);
    console.log(`  Send !chatid in a room to get its registration ID\n`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(/^mx:/, '');

      // Matrix has no hard limit but split at 4096 for readability
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.client.sendText(roomId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.client.sendText(roomId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mx:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stop();
      this.client = null;
      this.connected = false;
      logger.info('Matrix client stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(/^mx:/, '');
      await this.client.setTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }

  private async getDisplayName(
    roomId: string,
    userId: string,
  ): Promise<string> {
    try {
      const profile = await this.client!.getUserProfile(userId);
      return profile?.displayname || userId;
    } catch {
      return userId;
    }
  }
}
