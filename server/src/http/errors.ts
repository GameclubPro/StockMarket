export class ApiError extends Error {
  status: number;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const isFiniteStatus = (value: unknown) => Number.isFinite(value) && Number(value) >= 100;

const normalizeMessage = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'unexpected_error';
};

const detectStatusByMessage = (message: string, fallbackStatus: number) => {
  if (message === 'unauthorized' || message === 'user not found' || message === 'no user') {
    return 401;
  }
  if (
    message === 'group not found' ||
    message === 'campaign not found' ||
    message === 'application not found'
  ) {
    return 404;
  }
  if (message === 'not owner' || message === 'not admin') {
    return 403;
  }
  if (message === 'vk_identity_mismatch') {
    return 403;
  }
  if (
    message === 'campaign paused' ||
    message === 'budget empty' ||
    message === 'already reviewed' ||
    message === 'cooldown' ||
    message === 'vk_subscribe_auto_unavailable' ||
    message === 'vk_group_add_unavailable' ||
    message === 'vk_recheck_not_supported' ||
    message === 'vk_subscribe_auto_only'
  ) {
    return 409;
  }
  if (message === 'vk_verify_retry_cooldown') {
    return 429;
  }
  if (message === 'vk_verify_unavailable') {
    return 503;
  }
  if (
    message === 'invalid body' ||
    message === 'invalid query' ||
    message === 'cannot apply own campaign' ||
    message === 'insufficient_balance' ||
    message === 'budget too small' ||
    message === 'invalid link code' ||
    message === 'platform_link_code_invalid' ||
    message === 'platform_link_code_already_used' ||
    message === 'platform_link_code_expired' ||
    message === 'vk_subscribe_link_invalid' ||
    message === 'vk_group_link_invalid' ||
    message === 'vk_group_title_missing' ||
    message === 'group_title_too_short' ||
    message === 'vk_profile_id_mismatch' ||
    message === 'vk_user_token_invalid' ||
    message === 'vk_user_token_scope_missing' ||
    message === 'vk_user_token_expired'
  ) {
    return 400;
  }
  if (message === 'already on target platform') {
    return 409;
  }
  if (message === 'user_blocked') {
    return 423;
  }
  return fallbackStatus;
};

export const normalizeApiError = (error: unknown, fallbackStatus = 400) => {
  if (error instanceof ApiError) return error;

  const maybeStatus = (error as { status?: unknown } | null)?.status;
  const maybeMessage = (error as { message?: unknown } | null)?.message;
  const maybeDetails = (error as { details?: unknown } | null)?.details;
  const message = normalizeMessage(maybeMessage);
  const status = isFiniteStatus(maybeStatus)
    ? Number(maybeStatus)
    : detectStatusByMessage(message, fallbackStatus);
  const details =
    maybeDetails && typeof maybeDetails === 'object'
      ? (maybeDetails as Record<string, unknown>)
      : undefined;

  return new ApiError(message, status, details);
};

export const toPublicErrorMessage = (message: string) => {
  if (message === 'insufficient_balance') return 'Недостаточно баллов.';
  if (message === 'budget too small') return 'Бюджет меньше цены действия.';
  if (message === 'budget empty') return 'Бюджет исчерпан.';
  if (message === 'campaign paused') return 'Задание приостановлено.';
  if (message === 'already reviewed') return 'Заявка уже обработана.';
  if (message === 'invalid link code') return 'Код переключения платформы некорректен.';
  if (message === 'platform_link_code_invalid') return 'Код переключения недействителен.';
  if (message === 'platform_link_code_already_used') return 'Код переключения уже использован.';
  if (message === 'platform_link_code_expired') return 'Срок действия кода переключения истек.';
  if (message === 'already on target platform') return 'Вы уже на этой платформе.';
  if (message === 'vk_subscribe_auto_unavailable') {
    return 'Автопроверка вступления VK временно недоступна. Попробуйте позже.';
  }
  if (message === 'vk_group_add_unavailable') {
    return 'Подключение VK-сообщества недоступно: на сервере не настроен VK_API_TOKEN.';
  }
  if (message === 'vk_user_token_invalid') {
    return 'Нет доступа к VK токену. Разрешите доступ к сообществам и повторите импорт.';
  }
  if (message === 'vk_user_token_scope_missing') {
    return 'Приложению не выданы права к группам VK. Разрешите доступ и повторите импорт.';
  }
  if (message === 'vk_user_token_expired') {
    return 'Токен VK истек. Повторите импорт и заново подтвердите доступ.';
  }
  if (message === 'vk_identity_mismatch') {
    return 'Профиль VK не совпадает с текущим аккаунтом. Войдите в нужный VK-профиль.';
  }
  if (message === 'vk_profile_id_mismatch') {
    return 'VK профиль не совпадает с авторизацией mini app. Проверьте текущий аккаунт VK.';
  }
  if (message === 'vk_verify_retry_cooldown') {
    return 'Слишком рано для повторной проверки. Подождите несколько секунд.';
  }
  if (message === 'vk_verify_unavailable') {
    return 'VK API временно недоступен. Повторите проверку чуть позже.';
  }
  if (message === 'vk_recheck_not_supported') {
    return 'Повторная проверка доступна только для VK-заданий типа «Подписка».';
  }
  if (message === 'vk_subscribe_auto_only') {
    return 'Эта VK-подписка проверяется автоматически. Ручная модерация отключена.';
  }
  if (message === 'vk_subscribe_link_invalid') {
    return 'Ссылка на VK-сообщество некорректна. Проверьте формат ссылки.';
  }
  if (message === 'vk_group_link_invalid') {
    return 'Не удалось определить VK-сообщество по ссылке. Проверьте ссылку и попробуйте снова.';
  }
  if (message === 'vk_group_title_missing') {
    return 'Не удалось получить название VK-сообщества. Укажите название вручную.';
  }
  if (message === 'group_title_too_short') {
    return 'Название проекта должно содержать минимум 3 символа.';
  }
  if (message === 'user_blocked') return 'user_blocked';
  return message;
};
