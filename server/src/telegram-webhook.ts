type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
};

type TelegramChat = {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
};

type TelegramChatMember = {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user?: TelegramUser;
};

type TelegramMyChatMemberUpdate = {
  chat: TelegramChat;
  from: TelegramUser;
  new_chat_member: TelegramChatMember;
  old_chat_member: TelegramChatMember;
};

type TelegramChatMemberUpdate = {
  chat: TelegramChat;
  from: TelegramUser;
  date?: number;
  new_chat_member: TelegramChatMember;
  old_chat_member: TelegramChatMember;
};

type TelegramReaction = {
  type: string;
  emoji?: string;
};

type TelegramMessageReactionUpdate = {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  actor_chat?: TelegramChat;
  date?: number;
  old_reaction?: TelegramReaction[];
  new_reaction?: TelegramReaction[];
};

type TelegramReactionCount = {
  type: TelegramReaction;
  total_count: number;
};

type TelegramMessageReactionCountUpdate = {
  chat: TelegramChat;
  message_id: number;
  date?: number;
  reactions?: TelegramReactionCount[];
};

export type TelegramUpdate = {
  update_id: number;
  my_chat_member?: TelegramMyChatMemberUpdate;
  chat_member?: TelegramChatMemberUpdate;
  message_reaction?: TelegramMessageReactionUpdate;
  message_reaction_count?: TelegramMessageReactionCountUpdate;
};

type UpsertGroupPayload = {
  ownerId: string;
  chat: TelegramChat;
};

export const handleBotWebhookUpdate = async (
  update: TelegramUpdate,
  deps: {
    upsertUser: (user: TelegramUser) => Promise<{ id: string }>;
    upsertGroup: (payload: UpsertGroupPayload) => Promise<void>;
    handleReaction?: (payload: {
      chat: TelegramChat;
      user: TelegramUser;
      messageId: number;
      emoji?: string;
    }) => Promise<void>;
    handleReactionCount?: (payload: {
      chat: TelegramChat;
      messageId: number;
      totalCount: number;
    }) => Promise<void>;
    handleChatMember?: (payload: {
      chat: TelegramChat;
      user: TelegramUser;
      status: TelegramChatMember['status'];
    }) => Promise<void>;
  }
) => {
  const payload = update.my_chat_member;
  const reaction = update.message_reaction;
  const reactionCount = update.message_reaction_count;
  const chatMember = update.chat_member;

  if (reaction && reaction.user && reaction.chat) {
    if (reaction.new_reaction && reaction.new_reaction.length > 0) {
      await deps.handleReaction?.({
        chat: reaction.chat,
        user: reaction.user,
        messageId: reaction.message_id,
        emoji: reaction.new_reaction[0]?.emoji,
      });
    }
  }

  if (reactionCount && reactionCount.chat) {
    const totalCount = Array.isArray(reactionCount.reactions)
      ? reactionCount.reactions.reduce(
          (sum, item) => sum + (Number.isFinite(item.total_count) ? item.total_count : 0),
          0
        )
      : 0;
    await deps.handleReactionCount?.({
      chat: reactionCount.chat,
      messageId: reactionCount.message_id,
      totalCount,
    });
  }

  if (chatMember && chatMember.new_chat_member?.user && chatMember.chat) {
    const status = chatMember.new_chat_member.status;
    await deps.handleChatMember?.({
      chat: chatMember.chat,
      user: chatMember.new_chat_member.user,
      status,
    });
  }
  if (!payload) return { ok: true };

  const { chat, from, new_chat_member: newMember } = payload;
  if (!chat || !from || !newMember) return { ok: true };

  if (newMember.status !== 'administrator' && newMember.status !== 'creator') {
    return { ok: true };
  }

  if (!chat.username) {
    return { ok: true, skipped: 'missing_username' };
  }

  const owner = await deps.upsertUser(from);
  await deps.upsertGroup({ ownerId: owner.id, chat });

  return { ok: true };
};
