import 'dotenv/config';

const token = process.env.BOT_TOKEN;
const webhookUrl = process.env.BOT_WEBHOOK_URL;
const secret = process.env.BOT_WEBHOOK_SECRET;

if (!token || !webhookUrl) {
  console.log('BOT_TOKEN or BOT_WEBHOOK_URL is missing. Skipping setWebhook.');
  process.exit(0);
}

const params = new URLSearchParams();
params.set('url', webhookUrl);
params.set('allowed_updates', JSON.stringify(['my_chat_member']));
if (secret) params.set('secret_token', secret);

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: params,
});

let data;
try {
  data = await response.json();
} catch {
  console.error('setWebhook failed: invalid response');
  process.exit(1);
}

if (!data.ok) {
  console.error('setWebhook failed:', data);
  process.exit(1);
}

console.log('Webhook set:', data);
