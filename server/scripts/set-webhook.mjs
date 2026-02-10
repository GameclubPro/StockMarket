import 'dotenv/config';

const token = process.env.BOT_TOKEN;
const webhookUrl = process.env.BOT_WEBHOOK_URL;
const secret = process.env.BOT_WEBHOOK_SECRET;
const retries = parsePositiveInt(process.env.WEBHOOK_SET_RETRIES, 5);
const baseDelayMs = parsePositiveInt(process.env.WEBHOOK_SET_DELAY_MS, 1500);
const timeoutMs = parsePositiveInt(process.env.WEBHOOK_SET_TIMEOUT_MS, 10000);
const required = isTruthy(process.env.WEBHOOK_SET_REQUIRED);

if (!token || !webhookUrl) {
  console.log('BOT_TOKEN or BOT_WEBHOOK_URL is missing. Skipping setWebhook.');
  process.exit(0);
}

const params = new URLSearchParams();
params.set('url', webhookUrl);
params.set(
  'allowed_updates',
  JSON.stringify([
    'my_chat_member',
    'message_reaction',
    'message_reaction_count',
    'chat_member',
    'message',
  ])
);
if (secret) params.set('secret_token', secret);

const endpoint = `https://api.telegram.org/bot${token}/setWebhook`;
let lastError = null;

for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    const data = await setWebhook(endpoint, params, timeoutMs);
    console.log(`Webhook set (attempt ${attempt}/${retries}):`, data);
    process.exit(0);
  } catch (error) {
    lastError = error;
    const retryable = isRetryableError(error);
    const canRetry = retryable && attempt < retries;

    if (!canRetry) break;

    const delayMs = getRetryDelayMs(error, baseDelayMs, attempt);
    console.warn(
      `[setWebhook] attempt ${attempt}/${retries} failed: ${formatError(error)}. Retrying in ${delayMs}ms.`
    );
    await sleep(delayMs);
  }
}

const message = `[setWebhook] failed after ${retries} attempt(s): ${formatError(lastError)}`;
if (required) {
  console.error(`${message}. WEBHOOK_SET_REQUIRED=true, exiting with error.`);
  process.exit(1);
}

console.warn(`${message}. Continuing because WEBHOOK_SET_REQUIRED is not enabled.`);
process.exit(0);

async function setWebhook(url, bodyParams, timeout) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bodyParams,
    signal: AbortSignal.timeout(timeout),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error(`Invalid JSON response (status ${response.status})`);
    error.retryable = response.status >= 500;
    throw error;
  }

  if (!response.ok || !data?.ok) {
    const description = data?.description || response.statusText || 'unknown error';
    const error = new Error(`Telegram API error ${response.status}: ${description}`);
    error.retryable = response.status >= 500 || response.status === 429;
    if (typeof data?.parameters?.retry_after === 'number') {
      error.retryAfterMs = data.parameters.retry_after * 1000;
    }
    throw error;
  }

  return data;
}

function getRetryDelayMs(error, baseDelay, attempt) {
  if (typeof error?.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)) {
    return Math.max(500, error.retryAfterMs);
  }

  const cappedAttempt = Math.min(6, attempt);
  return baseDelay * 2 ** (cappedAttempt - 1);
}

function isRetryableError(error) {
  if (error?.retryable === true) return true;

  const code = error?.cause?.code || error?.code;
  return (
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function formatError(error) {
  if (!error) return 'unknown error';

  const code = error?.cause?.code || error?.code;
  return code ? `${error.message} (code: ${code})` : error.message;
}

function parsePositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
  return parsed;
}

function isTruthy(value) {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
