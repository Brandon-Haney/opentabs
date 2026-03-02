import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isDiscordAuthenticated, waitForDiscordAuth } from './discord-api.js';
import { sendMessage } from './tools/send-message.js';
import { editMessage } from './tools/edit-message.js';
import { deleteMessage } from './tools/delete-message.js';
import { readMessages } from './tools/read-messages.js';
import { readThread } from './tools/read-thread.js';
import { searchMessages } from './tools/search-messages.js';
import { listGuilds } from './tools/list-guilds.js';
import { listChannels } from './tools/list-channels.js';
import { getChannelInfo } from './tools/get-channel-info.js';
import { createChannel } from './tools/create-channel.js';
import { listMembers } from './tools/list-members.js';
import { getUserProfile } from './tools/get-user-profile.js';
import { listDms } from './tools/list-dms.js';
import { openDm } from './tools/open-dm.js';
import { addReaction } from './tools/add-reaction.js';
import { removeReaction } from './tools/remove-reaction.js';
import { pinMessage } from './tools/pin-message.js';
import { unpinMessage } from './tools/unpin-message.js';
import { createThread } from './tools/create-thread.js';

class DiscordPlugin extends OpenTabsPlugin {
  readonly name = 'discord';
  readonly description = 'OpenTabs plugin for Discord';
  override readonly displayName = 'Discord';
  readonly urlPatterns = ['*://discord.com/*'];
  readonly tools: ToolDefinition[] = [
    sendMessage,
    editMessage,
    deleteMessage,
    readMessages,
    readThread,
    searchMessages,
    listGuilds,
    listChannels,
    getChannelInfo,
    createChannel,
    listMembers,
    getUserProfile,
    listDms,
    openDm,
    addReaction,
    removeReaction,
    pinMessage,
    unpinMessage,
    createThread,
  ];

  async isReady(): Promise<boolean> {
    if (isDiscordAuthenticated()) return true;
    return waitForDiscordAuth();
  }
}

export default new DiscordPlugin();
