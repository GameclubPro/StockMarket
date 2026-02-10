export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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
  if (
    message === 'campaign paused' ||
    message === 'budget empty' ||
    message === 'already reviewed' ||
    message === 'cooldown'
  ) {
    return 409;
  }
  if (
    message === 'invalid body' ||
    message === 'invalid query' ||
    message === 'cannot apply own campaign' ||
    message === 'insufficient_balance' ||
    message === 'budget too small'
  ) {
    return 400;
  }
  return fallbackStatus;
};

export const normalizeApiError = (error: unknown, fallbackStatus = 400) => {
  if (error instanceof ApiError) return error;

  const maybeStatus = (error as { status?: unknown } | null)?.status;
  const maybeMessage = (error as { message?: unknown } | null)?.message;
  const message = normalizeMessage(maybeMessage);
  const status = isFiniteStatus(maybeStatus)
    ? Number(maybeStatus)
    : detectStatusByMessage(message, fallbackStatus);

  return new ApiError(message, status);
};

export const toPublicErrorMessage = (message: string) => {
  if (message === 'insufficient_balance') return 'Недостаточно баллов.';
  if (message === 'budget too small') return 'Бюджет меньше цены действия.';
  if (message === 'budget empty') return 'Бюджет исчерпан.';
  if (message === 'campaign paused') return 'Задание приостановлено.';
  if (message === 'already reviewed') return 'Заявка уже обработана.';
  return message;
};
