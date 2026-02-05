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

export type TelegramUpdate = {
  update_id: number;
  my_chat_member?: TelegramMyChatMemberUpdate;
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
  }
) => {
  const payload = update.my_chat_member;
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

