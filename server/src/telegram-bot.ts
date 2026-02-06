type BotApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type BotInfo = {
  id: number;
  username?: string;
};

type ChatMember = {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
};

type BotCheckError = Error & { code: string; status: number };

const API_BASE = 'https://api.telegram.org';
let cachedBotInfo: BotInfo | null = null;

const createBotCheckError = (code: string, message: string, status = 400): BotCheckError => {
  const error = new Error(message) as BotCheckError;
  error.code = code;
  error.status = status;
  return error;
};

const botRequest = async <T>(botToken: string, method: string, params?: Record<string, unknown>) => {
  const url = `${API_BASE}/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = (await response.json()) as BotApiResponse<T>;
  if (!data.ok) {
    const error = new Error(data.description ?? 'bot api error') as Error & {
      code?: number;
    };
    error.code = data.error_code;
    throw error;
  }
  return data.result as T;
};

const toChatId = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('@')) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  return `@${trimmed}`;
};

export const extractUsername = (value: string) => {
  const raw = value.trim();
  if (!raw) return '';
  if (raw.startsWith('@')) return raw;

  const simpleMatch = raw.match(/^[a-zA-Z0-9_]{5,32}$/);
  if (simpleMatch) return `@${raw}`;

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith('t.me') && !host.endsWith('telegram.me')) return '';
    const pathname = url.pathname.replace(/^\/+/, '');
    if (!pathname) return '';
    if (pathname.startsWith('+') || pathname.startsWith('joinchat')) return '';
    const username = pathname.split('/')[0];
    if (!username) return '';
    return `@${username}`;
  } catch {
    return '';
  }
};

export const getBotInfo = async (botToken: string) => {
  if (cachedBotInfo) return cachedBotInfo;
  const result = await botRequest<BotInfo>(botToken, 'getMe');
  cachedBotInfo = result;
  return result;
};

export const ensureBotIsAdmin = async (botToken: string, chatId: string) => {
  if (!botToken) throw createBotCheckError('bot_token_missing', 'BOT_TOKEN is missing', 500);
  const bot = await getBotInfo(botToken);

  try {
    const member = await botRequest<ChatMember>(botToken, 'getChatMember', {
      chat_id: toChatId(chatId),
      user_id: bot.id,
    });
    if (member.status !== 'administrator' && member.status !== 'creator') {
      throw createBotCheckError(
        'bot_not_admin',
        'Бот должен быть администратором канала/группы.'
      );
    }
  } catch (error: any) {
    const message = String(error?.message ?? '').toLowerCase();
    if (message.includes('chat not found')) {
      throw createBotCheckError('chat_not_found', 'Чат не найден. Укажите публичный @username.');
    }
    if (message.includes('chat_admin_required') || message.includes('not enough rights')) {
      throw createBotCheckError(
        'bot_not_admin',
        'Бот должен быть администратором канала/группы.'
      );
    }
    if (message.includes('user not found') || message.includes('member not found')) {
      throw createBotCheckError('bot_not_member', 'Добавьте бота в канал и дайте права администратора.');
    }
    if (error?.code === 401 || message.includes('unauthorized')) {
      throw createBotCheckError('bot_token_invalid', 'BOT_TOKEN недействителен', 500);
    }
    throw createBotCheckError('bot_api_error', 'Не удалось проверить бота в канале/группе.');
  }
};

export const getChatMemberStatus = async (botToken: string, chatId: string, userId: number) => {
  if (!botToken) throw createBotCheckError('bot_token_missing', 'BOT_TOKEN is missing', 500);

  try {
    const member = await botRequest<ChatMember>(botToken, 'getChatMember', {
      chat_id: toChatId(chatId),
      user_id: userId,
    });
    return member.status;
  } catch (error: any) {
    const message = String(error?.message ?? '').toLowerCase();
    if (message.includes('chat not found')) {
      throw createBotCheckError('chat_not_found', 'Чат не найден. Укажите публичный @username.');
    }
    if (message.includes('chat_admin_required') || message.includes('not enough rights')) {
      throw createBotCheckError(
        'bot_not_admin',
        'Бот должен быть администратором канала/группы.'
      );
    }
    if (message.includes('user not found') || message.includes('member not found')) {
      throw createBotCheckError('user_not_member', 'Пользователь не найден в чате.');
    }
    if (error?.code === 401 || message.includes('unauthorized')) {
      throw createBotCheckError('bot_token_invalid', 'BOT_TOKEN недействителен', 500);
    }
    throw createBotCheckError('bot_api_error', 'Не удалось проверить вступление.');
  }
};

export const exportChatInviteLink = async (botToken: string, chatId: string) => {
  if (!botToken) throw createBotCheckError('bot_token_missing', 'BOT_TOKEN is missing', 500);
  const result = await botRequest<string>(botToken, 'exportChatInviteLink', {
    chat_id: toChatId(chatId),
  });
  return result;
};

export const sendMessage = async (botToken: string, chatId: string, text: string) => {
  if (!botToken) throw createBotCheckError('bot_token_missing', 'BOT_TOKEN is missing', 500);
  const result = await botRequest<{ message_id: number }>(botToken, 'sendMessage', {
    chat_id: toChatId(chatId),
    text,
  });
  return result;
};

export const isActiveMemberStatus = (status: ChatMember['status']) =>
  status === 'member' || status === 'administrator' || status === 'creator';

export const isAdminMemberStatus = (status: ChatMember['status']) =>
  status === 'administrator' || status === 'creator';
