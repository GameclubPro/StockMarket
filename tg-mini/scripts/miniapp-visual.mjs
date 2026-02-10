#!/usr/bin/env node

import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';

const DEFAULT_PORT = 4173;
const DEFAULT_WIDTH = 390;
const DEFAULT_HEIGHT = 844;
const DEFAULT_WAIT_MS = 260;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_SAFE_BOTTOM_PX = 16;
const DEFAULT_SAFE_TOP_PX = 0;
const DEFAULT_MISMATCH_THRESHOLD_PCT = 0.25;
const DEFAULT_TG_TOP_BAR_PX = 48;
const DEFAULT_TG_FULLSCREEN_CONTROLS_PX = 34;
const DEFAULT_TG_MAIN_BUTTON_PX = 0;
const DEFAULT_TG_MAIN_BUTTON_GAP_PX = 12;
const DEFAULT_TG_MODE = 'fullscreen';
const DEFAULT_TG_WEBAPP_VERSION = '9.3';
const SUPPORTED_TG_MODES = new Set(['fullscreen', 'fullsize', 'compact']);
const SUPPORTED_MODES = new Set(['screenshot', 'scan', 'compare', 'emulator']);
const DEFAULT_OPEN_SCREEN = 'home';
const FIXTURE_NOW_MS = Date.parse('2026-01-15T12:00:00.000Z');
const APP_READY_SELECTOR = '.profile-card';

const TELEGRAM_MOCK_THEME_PARAMS = JSON.stringify({
  bg_color: '#0c0c14',
  text_color: '#e8e9f2',
  hint_color: '#9fa2b6',
  button_color: '#8ad2ff',
  button_text_color: '#001018',
  secondary_bg_color: '#10101b',
  header_bg_color: '#10101b',
});

const buildTelegramMockInitData = (mockAdminAccess) =>
  mockAdminAccess
    ? 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A100001%2C%22first_name%22%3A%22Тест%22%2C%22last_name%22%3A%22Пользователь%22%2C%22username%22%3A%22Nitchim%22%7D&auth_date=1710000000&hash=dev_hash'
    : 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A100001%2C%22first_name%22%3A%22Тест%22%2C%22last_name%22%3A%22Пользователь%22%2C%22username%22%3A%22design_bot%22%7D&auth_date=1710000000&hash=dev_hash';

const SCREEN_STEPS = [
  {
    id: 'home',
    open: async (page, waitMs) => {
      await ensureHome(page, waitMs);
      await page.waitForSelector('.profile-card', { timeout: 10_000 });
    },
  },
  {
    id: 'promo',
    open: async (page, waitMs) => {
      await openBottomTab(page, 'Продвижение', waitMs);
      await page.waitForSelector('.task-form-card', { timeout: 10_000 });
    },
  },
  {
    id: 'admin',
    open: async (page, waitMs) => {
      await ensureHome(page, waitMs);
      await openBottomTab(page, 'Админ', waitMs);
      await page.waitForSelector('.admin-panel-card', { timeout: 10_000 });
    },
  },
  {
    id: 'tasks',
    open: async (page, waitMs) => {
      await openBottomTab(page, 'Задания', waitMs);
      await page.waitForSelector('.segment.filters', { timeout: 10_000 });
    },
  },
  {
    id: 'wheel',
    open: async (page, waitMs) => {
      await ensureHome(page, waitMs);
      await page.locator('.daily-bonus-cta').first().click();
      await page.waitForSelector('.wheel-card', { timeout: 10_000 });
      await sleep(waitMs);
    },
  },
  {
    id: 'referrals',
    open: async (page, waitMs) => {
      await ensureHome(page, waitMs);
      await page.locator('.invite-button').first().click();
      await page.waitForSelector('.referral-hero', { timeout: 10_000 });
      await sleep(waitMs);
    },
  },
  {
    id: 'wheel-modal',
    open: async (page, waitMs) => {
      await ensureHome(page, waitMs);
      await page.locator('.daily-bonus-cta').first().click();
      await page.waitForSelector('.wheel-card', { timeout: 10_000 });
      await page.locator('.wheel-cta').first().click();
      await page.waitForSelector('.wheel-reward-modal', { timeout: 10_000 });
      await sleep(waitMs);
    },
  },
];
const SCREEN_ID_SET = new Set(SCREEN_STEPS.map((step) => step.id));

const usage = `
Использование:
  node scripts/miniapp-visual.mjs screenshot [опции]
  node scripts/miniapp-visual.mjs scan [опции]
  node scripts/miniapp-visual.mjs compare [опции]
  node scripts/miniapp-visual.mjs emulator [опции]

Опции:
  --width <px>       Ширина viewport (default: ${DEFAULT_WIDTH})
  --height <px>      Высота viewport (default: ${DEFAULT_HEIGHT})
  --outDir <path>    Папка для скриншотов (screenshot mode)
  --outFile <path>   Файл отчета (scan/compare mode)
  --baseUrl <url>    Готовый URL приложения, если dev-сервер уже запущен
  --port <number>    Порт локального dev-сервера (default: ${DEFAULT_PORT})
  --waitMs <number>  Пауза после переходов (default: ${DEFAULT_WAIT_MS})
  --safeTopPx <n>    Верхняя safe-area зона риска в px (scan mode, default: динамически)
  --safeBottomPx <n> Нижняя safe-area зона риска в px (scan mode, default: ${DEFAULT_SAFE_BOTTOM_PX})
  --tgMode <mode>    Режим Telegram viewport: fullscreen|fullsize|compact (default: ${DEFAULT_TG_MODE})
  --tgWebAppVersion <v> Версия Telegram WebApp API (default: ${DEFAULT_TG_WEBAPP_VERSION})
  --tgFullscreenControlsPx <n> Высота верхних fullscreen-контролов в px (default: ${DEFAULT_TG_FULLSCREEN_CONTROLS_PX})
  --tgTopBarPx <n>   Высота Telegram верхнего chrome в px (default: ${DEFAULT_TG_TOP_BAR_PX})
  --tgMainButtonPx <n> Высота Telegram Main Button в px (default: ${DEFAULT_TG_MAIN_BUTTON_PX})
  --tgMainButtonGapPx <n> Отступ Main Button снизу в px (default: ${DEFAULT_TG_MAIN_BUTTON_GAP_PX})
  --noTelegramChrome Отключить визуальную эмуляцию Telegram chrome
  --baselineDir <p>  Папка baseline PNG (compare mode)
  --afterDir <path>  Папка after PNG (compare mode)
  --diffDir <path>   Папка diff PNG (compare mode)
  --mismatchThresholdPct <n> Порог расхождения, % (compare mode, default: ${DEFAULT_MISMATCH_THRESHOLD_PCT})
  --clean            Очистить старые PNG перед screenshot/compare
  --headful          Запуск Chromium с UI
  --headless         Принудительно headless (полезно для mode=emulator)
  --noMockApi        Отключить API-моки и использовать реальный backend
  --openScreen <id>  Экран при запуске emulator: ${SCREEN_STEPS.map((step) => step.id).join('|')} (default: ${DEFAULT_OPEN_SCREEN})
  --allowNonFullscreen Разрешить fullsize/compact в emulator (по умолчанию fullscreen lock)
  --noEmulatorOverlay Отключить overlay-панель эмулятора (mode=emulator)
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eqIndex = body.indexOf('=');
    if (eqIndex > -1) {
      const key = body.slice(0, eqIndex);
      const value = body.slice(eqIndex + 1);
      args[key] = value === '' ? true : value;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[body] = true;
      continue;
    }
    args[body] = next;
    i += 1;
  }
  return args;
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toFloat(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toStringValue(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function toBooleanFlag(value) {
  return value === true || value === 'true';
}

function toTelegramMode(value, fallback = DEFAULT_TG_MODE) {
  const normalized = toStringValue(value, fallback).toLowerCase();
  if (SUPPORTED_TG_MODES.has(normalized)) return normalized;
  return fallback;
}

function toScreenId(value, fallback = DEFAULT_OPEN_SCREEN) {
  const normalized = toStringValue(value, fallback).toLowerCase();
  if (SCREEN_ID_SET.has(normalized)) return normalized;
  return fallback;
}

function resolvePath(value, fallback) {
  return path.resolve(process.cwd(), value ?? fallback);
}

function parseConfig(mode, rawArgs) {
  const width = toInt(rawArgs.width, DEFAULT_WIDTH);
  const height = toInt(rawArgs.height, DEFAULT_HEIGHT);
  const waitMs = toInt(rawArgs.waitMs, DEFAULT_WAIT_MS);
  const port = toInt(rawArgs.port, DEFAULT_PORT);
  const allowNonFullscreen = toBooleanFlag(rawArgs.allowNonFullscreen);
  const requestedTgMode = toTelegramMode(rawArgs.tgMode, DEFAULT_TG_MODE);
  const tgMode =
    mode === 'emulator' && !allowNonFullscreen
      ? 'fullscreen'
      : requestedTgMode;
  const tgWebAppVersion = toStringValue(rawArgs.tgWebAppVersion, DEFAULT_TG_WEBAPP_VERSION);
  const telegramChrome = !toBooleanFlag(rawArgs.noTelegramChrome);
  const tgTopBarPx = toNonNegativeInt(rawArgs.tgTopBarPx, DEFAULT_TG_TOP_BAR_PX);
  const tgFullscreenControlsPx = toNonNegativeInt(
    rawArgs.tgFullscreenControlsPx,
    DEFAULT_TG_FULLSCREEN_CONTROLS_PX
  );
  const tgMainButtonPx = toNonNegativeInt(rawArgs.tgMainButtonPx, DEFAULT_TG_MAIN_BUTTON_PX);
  const tgMainButtonGapPx = toNonNegativeInt(rawArgs.tgMainButtonGapPx, DEFAULT_TG_MAIN_BUTTON_GAP_PX);
  const topRiskInsetByMode =
    tgMode === 'fullscreen' ? tgFullscreenControlsPx : tgTopBarPx;
  const safeTopDefault = telegramChrome
    ? Math.max(DEFAULT_SAFE_TOP_PX, topRiskInsetByMode)
    : DEFAULT_SAFE_TOP_PX;
  const safeBottomDefault = Math.max(
    DEFAULT_SAFE_BOTTOM_PX,
    telegramChrome && tgMainButtonPx > 0 ? tgMainButtonPx + tgMainButtonGapPx : 0
  );
  const safeTopPx = toNonNegativeInt(rawArgs.safeTopPx, safeTopDefault);
  const safeBottomPx = toNonNegativeInt(rawArgs.safeBottomPx, safeBottomDefault);
  const mismatchThresholdPct = toFloat(
    rawArgs.mismatchThresholdPct,
    DEFAULT_MISMATCH_THRESHOLD_PCT
  );
  const cleanOutput = toBooleanFlag(rawArgs.clean);
  const headful = mode === 'emulator' ? !toBooleanFlag(rawArgs.headless) : toBooleanFlag(rawArgs.headful);
  const mockApi = !toBooleanFlag(rawArgs.noMockApi);
  const mockAdminAccess = !toBooleanFlag(rawArgs.noMockAdminAccess);
  const emulatorOverlay = !toBooleanFlag(rawArgs.noEmulatorOverlay);
  const openScreen = toScreenId(rawArgs.openScreen, DEFAULT_OPEN_SCREEN);
  const outDirDefault = `.logs/design-after-${width}x${height}`;
  const outFileDefault =
    mode === 'compare'
      ? `.logs/design-compare-${width}x${height}.json`
      : `.logs/mobile-scan-${width}x${height}.json`;
  const baselineDirDefault = `.logs/design-baseline-${width}`;
  const afterDirDefault = `.logs/design-after-${width}`;
  const diffDirDefault = `.logs/design-diff-${width}x${height}`;

  return {
    mode,
    width,
    height,
    waitMs,
    port,
    safeTopPx,
    safeBottomPx,
    tgMode,
    tgWebAppVersion,
    tgTopBarPx,
    tgFullscreenControlsPx,
    tgMainButtonPx,
    tgMainButtonGapPx,
    telegramChrome,
    cleanOutput,
    mismatchThresholdPct,
    headful,
    mockApi,
    mockAdminAccess,
    allowNonFullscreen,
    emulatorOverlay,
    openScreen,
    baseUrl: typeof rawArgs.baseUrl === 'string' ? rawArgs.baseUrl : '',
    outDir: resolvePath(rawArgs.outDir, outDirDefault),
    outFile: resolvePath(rawArgs.outFile, outFileDefault),
    baselineDir: resolvePath(rawArgs.baselineDir, baselineDirDefault),
    afterDir: resolvePath(rawArgs.afterDir, afterDirDefault),
    diffDir: resolvePath(rawArgs.diffDir, diffDirDefault),
  };
}

function buildTelegramMockQuery(config) {
  return new URLSearchParams({
    tgWebAppPlatform: 'android',
    tgWebAppVersion: config.tgWebAppVersion,
    tgWebAppThemeParams: TELEGRAM_MOCK_THEME_PARAMS,
    tgWebAppData: buildTelegramMockInitData(config.mockAdminAccess),
  }).toString();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function waitForServer(url, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= DEFAULT_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`Vite dev server завершился раньше времени (exit: ${child.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // ignored until timeout
    }
    await sleep(350);
  }
  throw new Error(`Не дождались запуска dev-сервера по адресу ${url}.`);
}

async function startDevServer(preferredPort, attempts = 25) {
  const command = getNpmCommand();
  let lastError = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    const args = ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      if (stdoutBuffer.length > 3000) {
        stdoutBuffer = stdoutBuffer.slice(-3000);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 3000) {
        stderrBuffer = stderrBuffer.slice(-3000);
      }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(baseUrl, child);
      return { baseUrl, child, port };
    } catch (error) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      const logs = [stdoutBuffer, stderrBuffer].filter(Boolean).join('\n');
      const text = logs.toLowerCase();
      const portBusy =
        text.includes('already in use') ||
        text.includes('eaddrinuse') ||
        text.includes('port') && text.includes('used');

      lastError = new Error(
        `${error instanceof Error ? error.message : 'Не удалось запустить dev-сервер'}${
          logs ? `\n\nVite logs:\n${logs}` : ''
        }`
      );

      if (portBusy) {
        continue;
      }

      throw lastError;
    }
  }

  throw (
    lastError ??
    new Error(
      `Не удалось запустить dev-сервер: закончились попытки в диапазоне ${preferredPort}-${
        preferredPort + attempts - 1
      }.`
    )
  );
}

async function stopDevServer(child) {
  if (!child || child.exitCode !== null) return;
  const killTree = (signal) => {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  killTree('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(3_000)]);

  if (child.exitCode === null) {
    killTree('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(2_000)]);
  }
}

function isoMinutesAgo(minutes) {
  return new Date(FIXTURE_NOW_MS - minutes * 60_000).toISOString();
}

function buildFixtures() {
  const myUser = {
    id: 'user-client-1',
    username: 'Nitchim',
    firstName: 'Тест',
    lastName: 'Пользователь',
    photoUrl: null,
    totalEarned: 1240,
  };

  const groupA = {
    id: 'group-alpha',
    title: 'Crypto Alpha',
    username: 'crypto_alpha',
    telegramChatId: '-1001234567890',
    inviteLink: 'https://t.me/crypto_alpha',
    description: 'Канал с рыночными сигналами',
    category: 'finance',
    createdAt: isoMinutesAgo(10_000),
  };

  const groupB = {
    id: 'group-beta',
    title: 'Wall Street Notes',
    username: 'wallstreet_notes',
    telegramChatId: '-1001234567891',
    inviteLink: 'https://t.me/wallstreet_notes',
    description: 'Инсайты и аналитика',
    category: 'finance',
    createdAt: isoMinutesAgo(9_500),
  };

  const groupMine = {
    id: 'group-my-1',
    title: 'Мой тестовый канал',
    username: 'my_test_channel',
    telegramChatId: '-1001234567001',
    inviteLink: 'https://t.me/my_test_channel',
    description: 'Канал для размещения задач',
    category: 'finance',
    createdAt: isoMinutesAgo(2_000),
  };

  const campaigns = [
    {
      id: 'campaign-subscribe-hot',
      actionType: 'SUBSCRIBE',
      targetMessageId: null,
      rewardPoints: 26,
      totalBudget: 1800,
      remainingBudget: 1260,
      status: 'ACTIVE',
      createdAt: isoMinutesAgo(42),
      group: groupA,
      owner: {
        id: 'user-owner-1',
        username: 'owner_1',
        firstName: 'Алексей',
        lastName: null,
        photoUrl: null,
      },
    },
    {
      id: 'campaign-subscribe-new',
      actionType: 'SUBSCRIBE',
      targetMessageId: null,
      rewardPoints: 18,
      totalBudget: 1200,
      remainingBudget: 800,
      status: 'ACTIVE',
      createdAt: isoMinutesAgo(18),
      group: groupB,
      owner: {
        id: 'user-owner-2',
        username: 'owner_2',
        firstName: 'Марина',
        lastName: null,
        photoUrl: null,
      },
    },
    {
      id: 'campaign-reaction-new',
      actionType: 'REACTION',
      targetMessageId: 1488,
      rewardPoints: 22,
      totalBudget: 1000,
      remainingBudget: 650,
      status: 'ACTIVE',
      createdAt: isoMinutesAgo(28),
      group: groupA,
      owner: {
        id: 'user-owner-3',
        username: 'owner_3',
        firstName: 'Игорь',
        lastName: null,
        photoUrl: null,
      },
    },
    {
      id: 'campaign-owned-by-me',
      actionType: 'SUBSCRIBE',
      targetMessageId: null,
      rewardPoints: 20,
      totalBudget: 900,
      remainingBudget: 500,
      status: 'ACTIVE',
      createdAt: isoMinutesAgo(55),
      group: groupMine,
      owner: {
        id: myUser.id,
        username: myUser.username,
        firstName: myUser.firstName,
        lastName: myUser.lastName,
        photoUrl: myUser.photoUrl,
      },
    },
  ];

  const myCampaigns = [
    {
      ...campaigns[3],
      remainingBudget: 410,
      status: 'ACTIVE',
    },
  ];

  const applications = [
    {
      id: 'app-approved-1',
      status: 'APPROVED',
      createdAt: isoMinutesAgo(200),
      reviewedAt: isoMinutesAgo(120),
      campaign: campaigns[0],
      applicant: {
        id: myUser.id,
        username: myUser.username,
        firstName: myUser.firstName,
        lastName: myUser.lastName,
        photoUrl: myUser.photoUrl,
      },
    },
    {
      id: 'app-pending-1',
      status: 'PENDING',
      createdAt: isoMinutesAgo(45),
      reviewedAt: null,
      campaign: campaigns[2],
      applicant: {
        id: myUser.id,
        username: myUser.username,
        firstName: myUser.firstName,
        lastName: myUser.lastName,
        photoUrl: myUser.photoUrl,
      },
    },
  ];

  return {
    myUser,
    balance: 680,
    campaigns,
    myCampaigns,
    applications,
    myGroups: [groupMine, groupA],
    dailyBonusStatus: {
      available: true,
      lastSpinAt: isoMinutesAgo(1_480),
      nextAvailableAt: null,
      cooldownMs: 24 * 60 * 60 * 1000,
      streak: 4,
    },
    dailyBonusSpin: {
      reward: { index: 4, value: 15, label: '+15' },
      balance: 695,
      totalEarned: 1255,
      lastSpinAt: new Date().toISOString(),
      nextAvailableAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      cooldownMs: 24 * 60 * 60 * 1000,
      streak: 5,
    },
    referralStats: {
      code: 'DESIGN2026',
      link: 'https://t.me/JoinRush_bot?startapp=DESIGN2026',
      stats: {
        invited: 7,
        earned: 490,
      },
    },
    referralList: [
      {
        id: 'ref-1',
        createdAt: isoMinutesAgo(15_000),
        completedOrders: 19,
        earned: 160,
        referredUser: {
          id: 'ref-user-1',
          username: 'trader_one',
          firstName: 'Олег',
          lastName: 'Смирнов',
          photoUrl: null,
        },
      },
      {
        id: 'ref-2',
        createdAt: isoMinutesAgo(11_000),
        completedOrders: 6,
        earned: 40,
        referredUser: {
          id: 'ref-user-2',
          username: 'market_girl',
          firstName: 'Ирина',
          lastName: null,
          photoUrl: null,
        },
      },
    ],
    adminPanelStats: {
      newUsersToday: 27,
      totalUsers: 1458,
      bonusGranted: 34,
      bonusLimit: 50,
      bonusRemaining: 16,
      periodStart: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
      periodEnd: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
  };
}

async function registerApiMocks(page) {
  const fixtures = buildFixtures();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === '/api/auth/verify' && method === 'POST') {
      await route.fulfill(
        jsonResponse({
          ok: true,
          token: 'mock-session-token',
          balance: fixtures.balance,
          user: fixtures.myUser,
          referralBonus: null,
        })
      );
      return;
    }

    if (pathname === '/api/me' && method === 'GET') {
      await route.fulfill(
        jsonResponse({
          ok: true,
          user: fixtures.myUser,
          balance: fixtures.balance,
          stats: { groups: fixtures.myGroups.length, campaigns: 4, applications: 2 },
        })
      );
      return;
    }

    if (pathname === '/api/campaigns' && method === 'GET') {
      const actionType = url.searchParams.get('actionType');
      const campaigns = actionType
        ? fixtures.campaigns.filter(
            (campaign) => campaign.actionType === String(actionType).toUpperCase()
          )
        : fixtures.campaigns;
      await route.fulfill(jsonResponse({ ok: true, campaigns }));
      return;
    }

    if (pathname === '/api/campaigns/my' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, campaigns: fixtures.myCampaigns }));
      return;
    }

    if (pathname === '/api/groups/my' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, groups: fixtures.myGroups }));
      return;
    }

    if (pathname === '/api/applications/my' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, applications: fixtures.applications }));
      return;
    }

    if (pathname === '/api/referrals/me' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, ...fixtures.referralStats }));
      return;
    }

    if (pathname === '/api/referrals/list' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, referrals: fixtures.referralList }));
      return;
    }

    if (pathname === '/api/daily-bonus/status' && method === 'GET') {
      await route.fulfill(jsonResponse({ ok: true, ...fixtures.dailyBonusStatus }));
      return;
    }

    if (pathname.endsWith('/admin/panel') && method === 'GET') {
      await route.fulfill(
        jsonResponse({ ok: true, allowed: true, stats: fixtures.adminPanelStats })
      );
      return;
    }

    if (pathname === '/api/daily-bonus/spin' && method === 'POST') {
      await route.fulfill(jsonResponse({ ok: true, ...fixtures.dailyBonusSpin }));
      return;
    }

    if (/^\/api\/campaigns\/[^/]+\/apply$/.test(pathname) && method === 'POST') {
      const campaignId = pathname.split('/')[3];
      const campaign = fixtures.campaigns.find((item) => item.id === campaignId) ?? fixtures.campaigns[0];
      await route.fulfill(
        jsonResponse({
          ok: true,
          application: {
            id: `app-${campaignId}`,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            reviewedAt: null,
            campaign,
            applicant: {
              id: fixtures.myUser.id,
              username: fixtures.myUser.username,
              firstName: fixtures.myUser.firstName,
              lastName: fixtures.myUser.lastName,
              photoUrl: fixtures.myUser.photoUrl,
            },
          },
          campaign,
          balance: fixtures.balance,
        })
      );
      return;
    }

    if (pathname === '/api/campaigns' && method === 'POST') {
      await route.fulfill(
        jsonResponse({
          ok: true,
          campaign: fixtures.myCampaigns[0],
          balance: fixtures.balance - 100,
        })
      );
      return;
    }

    await route.fulfill(jsonResponse({ ok: true }));
  });
}

async function installTelegramMocks(page, config) {
  await page.addInitScript((params) => {
    const normalizeMode = (value) => {
      const mode = typeof value === 'string' ? value.toLowerCase() : '';
      if (mode === 'fullscreen' || mode === 'fullsize' || mode === 'compact') {
        return mode;
      }
      return 'fullscreen';
    };

    const modeState = { value: normalizeMode(params?.tgMode) };
    const topBarPx = Math.max(0, Number(params?.tgTopBarPx) || 0);
    const fullscreenControlsPx = Math.max(0, Number(params?.tgFullscreenControlsPx) || 0);
    const mainButtonPx = Math.max(0, Number(params?.tgMainButtonPx) || 0);
    const mainButtonGapPx = Math.max(0, Number(params?.tgMainButtonGapPx) || 0);
    const enforceFullscreen = Boolean(params?.enforceFullscreen);
    const webAppVersion = typeof params?.tgWebAppVersion === 'string' ? params.tgWebAppVersion : '9.3';
    const buildInitData = (isAdmin) =>
      isAdmin
        ? 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A100001%2C%22first_name%22%3A%22Тест%22%2C%22last_name%22%3A%22Пользователь%22%2C%22username%22%3A%22Nitchim%22%7D&auth_date=1710000000&hash=dev_hash'
        : 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A100001%2C%22first_name%22%3A%22Тест%22%2C%22last_name%22%3A%22Пользователь%22%2C%22username%22%3A%22design_bot%22%7D&auth_date=1710000000&hash=dev_hash';

    const eventListeners = new Map();
    const storageFactory = () => {
      const store = new Map();
      return {
        setItem: (key, value, callback) => {
          const normalizedKey = String(key ?? '');
          store.set(normalizedKey, String(value ?? ''));
          if (typeof callback === 'function') callback(true);
          return Promise.resolve(true);
        },
        getItem: (key, callback) => {
          const normalizedKey = String(key ?? '');
          const value = store.has(normalizedKey) ? store.get(normalizedKey) : null;
          if (typeof callback === 'function') callback(value);
          return Promise.resolve(value);
        },
        removeItem: (key, callback) => {
          const normalizedKey = String(key ?? '');
          store.delete(normalizedKey);
          if (typeof callback === 'function') callback(true);
          return Promise.resolve(true);
        },
        clear: (callback) => {
          store.clear();
          if (typeof callback === 'function') callback(true);
          return Promise.resolve(true);
        },
      };
    };

    const cloudStorage = storageFactory();
    const deviceStorage = storageFactory();
    const secureStorage = storageFactory();

    const emitEvent = (eventType, payload = {}) => {
      const handlers = eventListeners.get(eventType);
      if (!handlers || handlers.size === 0) return;
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch {
          // noop
        }
      });
    };

    const onEvent = (eventType, callback) => {
      if (!eventType || typeof callback !== 'function') return;
      if (!eventListeners.has(eventType)) {
        eventListeners.set(eventType, new Set());
      }
      eventListeners.get(eventType).add(callback);
    };

    const offEvent = (eventType, callback) => {
      if (!eventType || typeof callback !== 'function') return;
      const handlers = eventListeners.get(eventType);
      if (!handlers) return;
      handlers.delete(callback);
    };

    const fireBooleanCallback = (callback, value) => {
      if (typeof callback === 'function') {
        try {
          callback(Boolean(value));
        } catch {
          // noop
        }
      }
      return Boolean(value);
    };

    const isVersionAtLeast = (minimumVersion) => {
      const toParts = (version) =>
        String(version ?? '')
          .split('.')
          .map((part) => Number.parseInt(part, 10))
          .map((value) => (Number.isFinite(value) ? value : 0));
      const current = toParts(webAppVersion);
      const target = toParts(minimumVersion);
      const maxLength = Math.max(current.length, target.length);

      for (let index = 0; index < maxLength; index += 1) {
        const currentPart = current[index] ?? 0;
        const targetPart = target[index] ?? 0;
        if (currentPart > targetPart) return true;
        if (currentPart < targetPart) return false;
      }
      return true;
    };

    const getTopInsetPx = () => (modeState.value === 'fullscreen' ? fullscreenControlsPx : topBarPx);
    const getViewportTopOffsetPx = () => (modeState.value === 'fullscreen' ? 0 : topBarPx);

    const mainButton = {
      isVisible: mainButtonPx > 0,
      isActive: true,
      isProgressVisible: false,
      text: 'Продолжить',
      show: () => {
        mainButton.isVisible = true;
        updateInsets(true);
      },
      hide: () => {
        mainButton.isVisible = false;
        updateInsets(true);
      },
      setText: (value) => {
        if (typeof value === 'string') mainButton.text = value;
        updateInsets(true);
        return mainButton;
      },
      onClick: () => {},
      offClick: () => {},
      enable: () => {
        mainButton.isActive = true;
        return mainButton;
      },
      disable: () => {
        mainButton.isActive = false;
        return mainButton;
      },
      showProgress: () => {
        mainButton.isProgressVisible = true;
        return mainButton;
      },
      hideProgress: () => {
        mainButton.isProgressVisible = false;
        return mainButton;
      },
      setParams: (nextParams) => {
        if (nextParams && typeof nextParams === 'object') {
          if (typeof nextParams.text === 'string') mainButton.text = nextParams.text;
          if (typeof nextParams.is_visible === 'boolean') {
            mainButton.isVisible = nextParams.is_visible;
          }
        }
        updateInsets(true);
        return mainButton;
      },
    };

    const secondaryButton = {
      isVisible: false,
      isActive: true,
      isProgressVisible: false,
      text: 'Отмена',
      position: 'left',
      show: () => {
        secondaryButton.isVisible = true;
        return secondaryButton;
      },
      hide: () => {
        secondaryButton.isVisible = false;
        return secondaryButton;
      },
      setText: (value) => {
        if (typeof value === 'string') secondaryButton.text = value;
        return secondaryButton;
      },
      onClick: () => {},
      offClick: () => {},
      enable: () => {
        secondaryButton.isActive = true;
        return secondaryButton;
      },
      disable: () => {
        secondaryButton.isActive = false;
        return secondaryButton;
      },
      showProgress: () => {
        secondaryButton.isProgressVisible = true;
        return secondaryButton;
      },
      hideProgress: () => {
        secondaryButton.isProgressVisible = false;
        return secondaryButton;
      },
      setParams: () => secondaryButton,
    };

    let webApp = null;
    const getBottomOffsetPx = () =>
      mainButton.isVisible ? Math.max(0, mainButtonPx + mainButtonGapPx) : 0;

    const updateInsets = (emitChanges = false) => {
      if (!webApp) return;
      const safeTopPx = getTopInsetPx();
      const viewportTopOffsetPx = getViewportTopOffsetPx();
      const bottomOffsetPx = getBottomOffsetPx();
      const viewportHeight = Math.max(0, window.innerHeight - viewportTopOffsetPx - bottomOffsetPx);
      const root = document.documentElement;

      webApp.isExpanded = modeState.value !== 'compact';
      webApp.isFullscreen = modeState.value === 'fullscreen';
      webApp.viewportHeight = viewportHeight;
      webApp.viewportStableHeight = viewportHeight;
      webApp.safeAreaInset = { top: safeTopPx, right: 0, bottom: bottomOffsetPx, left: 0 };
      webApp.contentSafeAreaInset = { top: safeTopPx, right: 0, bottom: bottomOffsetPx, left: 0 };

      root.style.setProperty(
        '--tg-header-overlay-offset',
        `${modeState.value === 'fullscreen' ? 0 : topBarPx}px`
      );
      root.style.setProperty('--tg-legacy-top-offset', `${safeTopPx}px`);
      root.style.setProperty('--tg-legacy-bottom-offset', `${bottomOffsetPx}px`);
      root.style.setProperty('--tg-top-reserved', `${safeTopPx}px`);
      root.style.setProperty('--tg-bottom-reserved', `${bottomOffsetPx}px`);
      root.style.setProperty('--tg-viewport-height', `${viewportHeight}px`);
      root.style.setProperty('--tg-viewport-stable-height', `${viewportHeight}px`);
      root.style.setProperty('--tg-viewport-safe-area-inset-top', `${safeTopPx}px`);
      root.style.setProperty('--tg-viewport-safe-area-inset-right', '0px');
      root.style.setProperty('--tg-viewport-safe-area-inset-bottom', `${bottomOffsetPx}px`);
      root.style.setProperty('--tg-viewport-safe-area-inset-left', '0px');
      root.style.setProperty('--tg-viewport-content-safe-area-inset-top', `${safeTopPx}px`);
      root.style.setProperty('--tg-viewport-content-safe-area-inset-right', '0px');
      root.style.setProperty('--tg-viewport-content-safe-area-inset-bottom', `${bottomOffsetPx}px`);
      root.style.setProperty('--tg-viewport-content-safe-area-inset-left', '0px');

      if (emitChanges) {
        emitEvent('viewportChanged', {
          height: viewportHeight,
          is_expanded: webApp.isExpanded,
          is_state_stable: true,
        });
        emitEvent('fullscreenChanged', {
          is_fullscreen: webApp.isFullscreen,
        });
        emitEvent('safeAreaChanged', { ...webApp.safeAreaInset });
        emitEvent('contentSafeAreaChanged', { ...webApp.contentSafeAreaInset });
      }
    };

    const setMode = (nextMode, emitChanges = true) => {
      const normalized = normalizeMode(nextMode);
      if (enforceFullscreen && normalized !== 'fullscreen') {
        emitEvent('fullscreenFailed', {
          error: 'fullscreen_locked',
          attempted_mode: normalized,
        });
        if (emitChanges) {
          updateInsets(true);
        }
        return false;
      }

      modeState.value = normalized;
      updateInsets(emitChanges);
      return true;
    };

    webApp = {
      isExpanded: modeState.value !== 'compact',
      isFullscreen: modeState.value === 'fullscreen',
      viewportHeight: window.innerHeight,
      viewportStableHeight: window.innerHeight,
      safeAreaInset: { top: 0, right: 0, bottom: 0, left: 0 },
      contentSafeAreaInset: { top: 0, right: 0, bottom: 0, left: 0 },
      platform: 'android',
      version: webAppVersion,
      isVersionAtLeast,
      isActive: document.visibilityState !== 'hidden',
      colorScheme: 'dark',
      themeParams: {
        bg_color: '#0c0c14',
        text_color: '#e8e9f2',
        hint_color: '#9fa2b6',
        button_color: '#8ad2ff',
        button_text_color: '#001018',
        secondary_bg_color: '#10101b',
        header_bg_color: '#10101b',
      },
      initDataUnsafe: {
        user: {
          id: 100001,
          first_name: 'Тест',
          last_name: 'Пользователь',
          username: params?.mockAdminAccess ? 'Nitchim' : 'design_bot',
        },
      },
      initData: buildInitData(Boolean(params?.mockAdminAccess)),
      ready: () => {},
      close: () => {},
      expand: () => {
        if (enforceFullscreen) {
          setMode('fullscreen', true);
          return;
        }
        if (modeState.value === 'compact') {
          setMode('fullsize', true);
          return;
        }
        updateInsets(true);
      },
      requestFullscreen: () => {
        const changed = setMode('fullscreen', true);
        return Promise.resolve(changed);
      },
      exitFullscreen: () => {
        const changed = setMode('fullsize', true);
        return Promise.resolve(changed);
      },
      openLink: () => {},
      openTelegramLink: () => {},
      switchInlineQuery: () => {},
      switchInlineQueryChosenChat: () => {},
      sendData: () => {},
      showAlert: () => {},
      showConfirm: (_text, callback) => {
        if (typeof callback === 'function') callback(true);
      },
      showPopup: (_params, callback) => {
        if (typeof callback === 'function') callback('ok');
      },
      showScanQrPopup: () => {},
      closeScanQrPopup: () => {},
      readTextFromClipboard: (_callback) => {},
      hideKeyboard: () => {},
      setHeaderColor: () => {},
      setBackgroundColor: () => {},
      setBottomBarColor: () => {},
      requestWriteAccess: (callback) => {
        fireBooleanCallback(callback, true);
      },
      requestContact: (callback) => {
        fireBooleanCallback(callback, false);
      },
      requestPhoneAccess: (callback) => {
        fireBooleanCallback(callback, false);
      },
      requestEmojiStatusAccess: (callback) => {
        fireBooleanCallback(callback, true);
      },
      setEmojiStatus: (_customEmojiId, callback) => {
        fireBooleanCallback(callback, true);
      },
      addToHomeScreen: (callback) => {
        fireBooleanCallback(callback, true);
      },
      checkHomeScreenStatus: (callback) => {
        if (typeof callback === 'function') {
          try {
            callback('added');
          } catch {
            // noop
          }
        }
      },
      shareToStory: (_url, _params, callback) => {
        fireBooleanCallback(callback, true);
      },
      downloadFile: (_params, callback) => {
        fireBooleanCallback(callback, true);
      },
      enableClosingConfirmation: () => {},
      disableClosingConfirmation: () => {},
      enableVerticalSwipes: () => {},
      disableVerticalSwipes: () => {},
      lockOrientation: () => {},
      unlockOrientation: () => {},
      onEvent,
      offEvent,
      MainButton: mainButton,
      BottomButton: mainButton,
      SecondaryButton: secondaryButton,
      BackButton: {
        isVisible: false,
        show: () => {},
        hide: () => {},
        onClick: () => {},
        offClick: () => {},
      },
      SettingsButton: {
        isVisible: false,
        show: () => {},
        hide: () => {},
        onClick: () => {},
        offClick: () => {},
      },
      HapticFeedback: {
        impactOccurred: () => {},
        notificationOccurred: () => {},
        selectionChanged: () => {},
      },
      CloudStorage: cloudStorage,
      DeviceStorage: deviceStorage,
      SecureStorage: secureStorage,
      BiometricManager: {
        isInited: true,
        isBiometricAvailable: false,
        isAccessRequested: false,
        isAccessGranted: false,
        isBiometricTokenSaved: false,
        init: (callback) => {
          if (typeof callback === 'function') callback();
        },
      },
      __emulator: {
        enforceFullscreen,
        getMode: () => modeState.value,
        setMode: (value) => setMode(value, true),
        setMainButtonVisible: (visible) => {
          mainButton.isVisible = Boolean(visible);
          updateInsets(true);
        },
        toggleMainButton: () => {
          mainButton.isVisible = !mainButton.isVisible;
          updateInsets(true);
          return mainButton.isVisible;
        },
      },
    };

    updateInsets(false);
    window.addEventListener('resize', () => updateInsets(true), { passive: true });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (!webApp) return;
        webApp.isActive = document.visibilityState !== 'hidden';
        emitEvent(webApp.isActive ? 'activated' : 'deactivated');
      },
      { passive: true }
    );
    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      writable: true,
      value: { WebApp: webApp },
    });
  }, {
    tgMode: config.tgMode,
    tgWebAppVersion: config.tgWebAppVersion,
    tgTopBarPx: config.tgTopBarPx,
    tgFullscreenControlsPx: config.tgFullscreenControlsPx,
    tgMainButtonPx: config.tgMainButtonPx,
    tgMainButtonGapPx: config.tgMainButtonGapPx,
    mockAdminAccess: config.mockAdminAccess,
    enforceFullscreen: config.mode === 'emulator' && !config.allowNonFullscreen,
  });
}

async function installTelegramChrome(page, config) {
  if (!config.telegramChrome) return;

  await page.addStyleTag({
    content: `
      .tg-visual-chrome {
        position: fixed;
        left: 0;
        right: 0;
        z-index: 2147483646;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      .tg-visual-chrome-top {
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        background:
          linear-gradient(180deg, rgba(14, 20, 28, 0.96), rgba(10, 15, 22, 0.92));
        border-bottom: 1px solid rgba(210, 232, 250, 0.14);
        color: rgba(229, 244, 255, 0.92);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }

      .tg-visual-chrome-top-fullscreen {
        background:
          linear-gradient(180deg, rgba(8, 14, 21, 0.58), rgba(8, 14, 21, 0));
        border-bottom: none;
        color: rgba(233, 246, 255, 0.88);
      }

      .tg-visual-top-side {
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }

      .tg-visual-back {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 1px solid rgba(219, 241, 255, 0.26);
        display: grid;
        place-items: center;
        font-size: 10px;
      }

      .tg-visual-chrome-main-button-wrap {
        position: fixed;
        left: 12px;
        right: 12px;
        z-index: 2147483646;
        pointer-events: none;
      }

      .tg-visual-chrome-main-button {
        width: 100%;
        border-radius: 14px;
        display: grid;
        place-items: center;
        font-size: 14px;
        font-weight: 700;
        color: #062236;
        background: linear-gradient(140deg, #9cecff 0%, #78d0ff 100%);
        border: 1px solid rgba(235, 250, 255, 0.75);
        box-shadow:
          0 10px 22px rgba(0, 0, 0, 0.36),
          inset 0 1px 0 rgba(255, 255, 255, 0.74);
      }
    `,
  });

  await page.evaluate((params) => {
    const fallbackMode = typeof params?.tgMode === 'string' ? params.tgMode : 'fullscreen';
    const topBarPx = Math.max(0, Number(params?.tgTopBarPx) || 0);
    const fullscreenControlsPx = Math.max(0, Number(params?.tgFullscreenControlsPx) || 0);
    const mainButtonPx = Math.max(0, Number(params?.tgMainButtonPx) || 0);
    const mainButtonGapPx = Math.max(0, Number(params?.tgMainButtonGapPx) || 0);

    const getWebApp = () => window.Telegram?.WebApp;
    const getMode = () => {
      const webApp = getWebApp();
      if (!webApp) return fallbackMode;
      if (typeof webApp.__emulator?.getMode === 'function') {
        return webApp.__emulator.getMode();
      }
      if (webApp.isFullscreen) return 'fullscreen';
      return webApp.isExpanded ? 'fullsize' : 'compact';
    };

    const removeChrome = () => {
      document.querySelectorAll('.tg-visual-chrome').forEach((node) => node.remove());
      document.querySelectorAll('.tg-visual-chrome-main-button-wrap').forEach((node) => node.remove());
    };

    const renderChrome = () => {
      removeChrome();
      const mode = getMode();
      const webApp = getWebApp();
      const mainButtonVisible = Boolean(webApp?.MainButton?.isVisible);

      if ((mode === 'fullsize' || mode === 'compact') && topBarPx > 0) {
        const top = document.createElement('div');
        top.className = 'tg-visual-chrome tg-visual-chrome-top';
        top.style.height = `${topBarPx}px`;
        top.innerHTML = `
          <div class="tg-visual-top-side">
            <span class="tg-visual-back">◀</span>
            <span>Telegram</span>
          </div>
          <div class="tg-visual-top-side">
            <span>⋮</span>
          </div>
        `;
        document.body.appendChild(top);
      }

      if (mode === 'fullscreen' && fullscreenControlsPx > 0) {
        const top = document.createElement('div');
        top.className = 'tg-visual-chrome tg-visual-chrome-top tg-visual-chrome-top-fullscreen';
        top.style.height = `${fullscreenControlsPx}px`;
        top.innerHTML = `
          <div class="tg-visual-top-side">
            <span class="tg-visual-back">◀</span>
          </div>
          <div class="tg-visual-top-side">
            <span>⋮</span>
          </div>
        `;
        document.body.appendChild(top);
      }

      if (mainButtonPx > 0 && mainButtonVisible) {
        const wrap = document.createElement('div');
        wrap.className = 'tg-visual-chrome-main-button-wrap';
        wrap.style.bottom = `${mainButtonGapPx}px`;
        const btn = document.createElement('div');
        btn.className = 'tg-visual-chrome-main-button';
        btn.style.height = `${mainButtonPx}px`;
        btn.textContent = String(webApp?.MainButton?.text || 'Main Button');
        wrap.appendChild(btn);
        document.body.appendChild(wrap);
      }
    };

    const stateKey = '__tgVisualChromeController';
    const previous = window[stateKey];
    if (typeof previous?.cleanup === 'function') {
      previous.cleanup();
    }

    const handleRefresh = () => renderChrome();
    const webApp = getWebApp();
    if (webApp?.onEvent) {
      webApp.onEvent('viewportChanged', handleRefresh);
      webApp.onEvent('fullscreenChanged', handleRefresh);
      webApp.onEvent('safeAreaChanged', handleRefresh);
      webApp.onEvent('contentSafeAreaChanged', handleRefresh);
    }
    window.addEventListener('resize', handleRefresh, { passive: true });
    renderChrome();

    window[stateKey] = {
      cleanup: () => {
        const currentWebApp = getWebApp();
        if (currentWebApp?.offEvent) {
          currentWebApp.offEvent('viewportChanged', handleRefresh);
          currentWebApp.offEvent('fullscreenChanged', handleRefresh);
          currentWebApp.offEvent('safeAreaChanged', handleRefresh);
          currentWebApp.offEvent('contentSafeAreaChanged', handleRefresh);
        }
        window.removeEventListener('resize', handleRefresh);
        removeChrome();
      },
    };
  }, {
    tgMode: config.tgMode,
    tgTopBarPx: config.tgTopBarPx,
    tgFullscreenControlsPx: config.tgFullscreenControlsPx,
    tgMainButtonPx: config.tgMainButtonPx,
    tgMainButtonGapPx: config.tgMainButtonGapPx,
  });
}

async function disableMotion(page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}

async function blockUnstableAssets(page) {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
}

async function waitForFonts(page, timeoutMs = 10_000) {
  await page
    .evaluate(async (ms) => {
      if (!document.fonts?.ready) return;
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)),
      ]);
    }, timeoutMs)
    .catch(() => undefined);
}

async function openBottomTab(page, label, waitMs) {
  const button = page.locator('.bottom-nav .nav-item').filter({ hasText: label }).first();
  const byText = page.locator('.bottom-nav .nav-item span', { hasText: label }).first();

  if (label === 'Админ') {
    const profileButton = page.locator('.profile-card .sub.sub-admin').first();
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await sleep(waitMs);
        return;
      }
      if (await byText.isVisible().catch(() => false)) {
        await byText.click();
        await sleep(waitMs);
        return;
      }
      if (await profileButton.isVisible().catch(() => false)) {
        await profileButton.click();
        await sleep(waitMs);
        return;
      }
      await sleep(220);
    }
  }

  try {
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await button.click();
  } catch {
    await byText.waitFor({ state: 'visible', timeout: 10_000 });
    await byText.click();
  }
  await sleep(waitMs);
}

async function ensureHome(page, waitMs) {
  const profileCard = page.locator('.profile-card').first();
  if (await profileCard.isVisible().catch(() => false)) return;

  const homeTab = page
    .locator('.bottom-nav .nav-item')
    .filter({ hasText: 'Главная' })
    .first();
  if (await homeTab.isVisible().catch(() => false)) {
    await homeTab.click();
    await page.waitForSelector(APP_READY_SELECTOR, { timeout: 10_000 });
    await sleep(waitMs);
    return;
  }

  const backButton = page.locator('.page-header .icon-button[aria-label="Назад"]').first();
  if (await backButton.isVisible().catch(() => false)) {
    await backButton.click();
    await page.waitForSelector(APP_READY_SELECTOR, { timeout: 10_000 });
    await sleep(waitMs);
    return;
  }

  await page.waitForSelector(APP_READY_SELECTOR, { timeout: 10_000 });
}

async function resetContentScroll(page) {
  await page.evaluate(() => {
    const content = document.querySelector('.content');
    if (content && 'scrollTop' in content) {
      content.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
}

async function openScreenById(page, waitMs, screenId) {
  const normalized = String(screenId || DEFAULT_OPEN_SCREEN).toLowerCase();
  const step = SCREEN_STEPS.find((candidate) => candidate.id === normalized);
  if (!step) {
    throw new Error(
      `Неизвестный screen id "${screenId}". Допустимые: ${SCREEN_STEPS.map((item) => item.id).join(', ')}.`
    );
  }

  await step.open(page, waitMs);
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
  await resetContentScroll(page);
  await sleep(Math.max(waitMs, 400));
}

async function runFlow(page, waitMs, onScreen) {
  for (const step of SCREEN_STEPS) {
    await openScreenById(page, waitMs, step.id);
    await sleep(Math.max(waitMs, 900));
    await onScreen(step.id);
  }
}

function buildScreenFileName(screenId, width, height) {
  return `${screenId}-${width}x${height}.png`;
}

async function resetOutputDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function runScreenshotMode(page, config) {
  if (config.cleanOutput) {
    await resetOutputDir(config.outDir);
  } else {
    await fs.mkdir(config.outDir, { recursive: true });
  }

  await runFlow(page, config.waitMs, async (screenId) => {
    const file = path.join(config.outDir, buildScreenFileName(screenId, config.width, config.height));
    await page.screenshot({ path: file });
    console.log(`[screenshot] ${screenId} -> ${file}`);
  });
}

async function collectAudit(page, screenId, safeBottomPx, safeTopPx) {
  const result = await page.evaluate(({ bottomSafeInsetPx, topSafeInsetPx }) => {
    const minSize = 44;
    const safeInset = Math.max(0, Number(bottomSafeInsetPx) || 0);
    const topSafeInset = Math.max(0, Number(topSafeInsetPx) || 0);
    const interactiveSelector = [
      'button',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="tab"]',
    ].join(', ');
    const tooSmall = [];
    const bottomRisk = [];
    const topRisk = [];

    document.querySelectorAll(interactiveSelector).forEach((element) => {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
        return;
      }

      if (rect.width < minSize || rect.height < minSize) {
        const text = (element.textContent || element.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        tooSmall.push({
          tag: element.tagName.toLowerCase(),
          text: text || '(без текста)',
          width: Number(rect.width.toFixed(1)),
          height: Number(rect.height.toFixed(1)),
        });
      }

      if (topSafeInset > 0 && rect.top < topSafeInset && !element.closest('.tg-visual-chrome')) {
        const text = (element.textContent || element.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        topRisk.push({
          tag: element.tagName.toLowerCase(),
          text: text || '(без текста)',
          top: Number(rect.top.toFixed(1)),
          distanceFromTop: Number(rect.top.toFixed(1)),
        });
      }

      if (rect.bottom > window.innerHeight - safeInset && !element.closest('.bottom-nav')) {
        const text = (element.textContent || element.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        bottomRisk.push({
          tag: element.tagName.toLowerCase(),
          text: text || '(без текста)',
          bottom: Number(rect.bottom.toFixed(1)),
          distanceToBottom: Number((window.innerHeight - rect.bottom).toFixed(1)),
        });
      }
    });

    const doc = document.documentElement;
    const horizontalOverflowPx = Math.max(0, Math.ceil(doc.scrollWidth - window.innerWidth));
    const content = document.querySelector('.content');
    const bottomNav = document.querySelector('.bottom-nav');

    const contentMetrics = content
      ? {
          scrollHeight: Math.round(content.scrollHeight),
          clientHeight: Math.round(content.clientHeight),
          canScroll: content.scrollHeight > content.clientHeight + 2,
        }
      : null;

    const bottomNavMetrics = bottomNav
      ? (() => {
          const rect = bottomNav.getBoundingClientRect();
          return {
            height: Number(rect.height.toFixed(1)),
            top: Number(rect.top.toFixed(1)),
            bottom: Number(rect.bottom.toFixed(1)),
            isInsideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
          };
        })()
      : null;

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      horizontalOverflowPx,
      tooSmallTapTargets: tooSmall,
      tooSmallCount: tooSmall.length,
      topSafeAreaRiskTargets: topRisk,
      topSafeAreaRiskCount: topRisk.length,
      bottomSafeAreaRiskTargets: bottomRisk,
      bottomSafeAreaRiskCount: bottomRisk.length,
      contentMetrics,
      bottomNavMetrics,
      issueCount:
        (horizontalOverflowPx > 0 ? 1 : 0) +
        (tooSmall.length > 0 ? 1 : 0) +
        (topRisk.length > 0 ? 1 : 0) +
        (bottomRisk.length > 0 ? 1 : 0),
    };
  }, { bottomSafeInsetPx: safeBottomPx, topSafeInsetPx: safeTopPx });

  return { screenId, ...result };
}

async function runScanMode(page, config) {
  const report = {
    generatedAt: new Date().toISOString(),
    viewport: {
      width: config.width,
      height: config.height,
    },
    screens: {},
    summary: {
      totalScreens: SCREEN_STEPS.length,
      screensWithOverflow: 0,
      screensWithTapTargetIssues: 0,
      screensWithTopSafeAreaRisks: 0,
      screensWithSafeAreaRisks: 0,
      totalSmallTapTargets: 0,
      totalTopSafeAreaRiskTargets: 0,
      totalSafeAreaRiskTargets: 0,
    },
  };

  await runFlow(page, config.waitMs, async (screenId) => {
    const audit = await collectAudit(page, screenId, config.safeBottomPx, config.safeTopPx);
    report.screens[screenId] = audit;
    if (audit.horizontalOverflowPx > 0) report.summary.screensWithOverflow += 1;
    if (audit.tooSmallCount > 0) report.summary.screensWithTapTargetIssues += 1;
    if (audit.topSafeAreaRiskCount > 0) report.summary.screensWithTopSafeAreaRisks += 1;
    if (audit.bottomSafeAreaRiskCount > 0) report.summary.screensWithSafeAreaRisks += 1;
    report.summary.totalSmallTapTargets += audit.tooSmallCount;
    report.summary.totalTopSafeAreaRiskTargets += audit.topSafeAreaRiskCount;
    report.summary.totalSafeAreaRiskTargets += audit.bottomSafeAreaRiskCount;
    console.log(
      `[scan] ${screenId}: overflow=${audit.horizontalOverflowPx}px, smallTargets=${audit.tooSmallCount}, topSafeAreaRisks=${audit.topSafeAreaRiskCount}, bottomSafeAreaRisks=${audit.bottomSafeAreaRiskCount}`
    );
  });

  await fs.mkdir(path.dirname(config.outFile), { recursive: true });
  await fs.writeFile(config.outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[scan] report -> ${config.outFile}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listPngFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function readPng(buffer) {
  return PNG.sync.read(buffer);
}

async function compareImages(fileA, fileB, diffFilePath) {
  const [rawA, rawB] = await Promise.all([fs.readFile(fileA), fs.readFile(fileB)]);
  const imageA = readPng(rawA);
  const imageB = readPng(rawB);

  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    return {
      status: 'dimension_mismatch',
      widthA: imageA.width,
      heightA: imageA.height,
      widthB: imageB.width,
      heightB: imageB.height,
      diffPixels: null,
      diffPercent: null,
    };
  }

  const diff = new PNG({ width: imageA.width, height: imageA.height });
  const diffPixels = pixelmatch(imageA.data, imageB.data, diff.data, imageA.width, imageA.height, {
    threshold: 0.1,
  });
  const totalPixels = imageA.width * imageA.height;
  const diffPercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;

  if (diffPixels > 0) {
    await fs.mkdir(path.dirname(diffFilePath), { recursive: true });
    await fs.writeFile(diffFilePath, PNG.sync.write(diff));
  }

  return {
    status: 'ok',
    widthA: imageA.width,
    heightA: imageA.height,
    widthB: imageB.width,
    heightB: imageB.height,
    diffPixels,
    diffPercent,
  };
}

async function runCompareMode(config) {
  if (!(await pathExists(config.baselineDir))) {
    throw new Error(`Папка baseline не найдена: ${config.baselineDir}`);
  }
  if (!(await pathExists(config.afterDir))) {
    throw new Error(`Папка after не найдена: ${config.afterDir}`);
  }

  const baselineFiles = await listPngFiles(config.baselineDir);
  const afterFiles = await listPngFiles(config.afterDir);
  const baselineSet = new Set(baselineFiles);
  const afterSet = new Set(afterFiles);

  const onlyBaseline = baselineFiles.filter((name) => !afterSet.has(name));
  const onlyAfter = afterFiles.filter((name) => !baselineSet.has(name));
  const matched = baselineFiles.filter((name) => afterSet.has(name));

  if (matched.length === 0) {
    throw new Error(
      `Нет совпадающих PNG-файлов между ${config.baselineDir} и ${config.afterDir}.`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baselineDir: config.baselineDir,
    afterDir: config.afterDir,
    diffDir: config.diffDir,
    mismatchThresholdPct: config.mismatchThresholdPct,
    filesOnlyInBaseline: onlyBaseline,
    filesOnlyInAfter: onlyAfter,
    filesCompared: {},
    summary: {
      comparedCount: matched.length,
      passedCount: 0,
      failedCount: 0,
      dimensionMismatchCount: 0,
      maxDiffPercent: 0,
      avgDiffPercent: 0,
    },
  };

  let diffPercentSum = 0;
  let diffPercentCount = 0;

  if (config.cleanOutput) {
    await resetOutputDir(config.diffDir);
  } else {
    await fs.mkdir(config.diffDir, { recursive: true });
  }

  for (const fileName of matched) {
    const baselineFile = path.join(config.baselineDir, fileName);
    const afterFile = path.join(config.afterDir, fileName);
    const diffFile = path.join(config.diffDir, fileName);
    const result = await compareImages(baselineFile, afterFile, diffFile);

    let status = 'pass';
    if (result.status === 'dimension_mismatch') {
      status = 'dimension_mismatch';
      report.summary.dimensionMismatchCount += 1;
      report.summary.failedCount += 1;
    } else {
      const diffPercent = Number(result.diffPercent.toFixed(4));
      if (diffPercent > report.summary.maxDiffPercent) {
        report.summary.maxDiffPercent = diffPercent;
      }
      diffPercentSum += diffPercent;
      diffPercentCount += 1;
      if (diffPercent > config.mismatchThresholdPct) {
        status = 'fail';
        report.summary.failedCount += 1;
      } else {
        report.summary.passedCount += 1;
      }
    }

    report.filesCompared[fileName] = {
      ...result,
      status,
      diffFile: result.status === 'ok' && result.diffPixels > 0 ? diffFile : null,
    };

    if (result.status === 'ok') {
      console.log(
        `[compare] ${fileName}: diff=${result.diffPercent.toFixed(4)}% (${status.toUpperCase()})`
      );
    } else {
      console.log(`[compare] ${fileName}: DIMENSION MISMATCH (${status.toUpperCase()})`);
    }
  }

  report.summary.avgDiffPercent =
    diffPercentCount > 0 ? Number((diffPercentSum / diffPercentCount).toFixed(4)) : 0;
  report.summary.maxDiffPercent = Number(report.summary.maxDiffPercent.toFixed(4));

  await fs.mkdir(path.dirname(config.outFile), { recursive: true });
  await fs.writeFile(config.outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[compare] report -> ${config.outFile}`);
}

async function installEmulatorOverlay(page, config) {
  if (!config.emulatorOverlay) return;

  await page.addStyleTag({
    content: `
      .tg-emulator-overlay {
        position: fixed;
        right: 10px;
        bottom: 14px;
        z-index: 2147483647;
        width: min(240px, calc(100vw - 20px));
        border-radius: 14px;
        padding: 10px;
        background: rgba(8, 12, 18, 0.88);
        border: 1px solid rgba(180, 220, 255, 0.3);
        color: #dceeff;
        font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        backdrop-filter: blur(8px);
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.44);
      }

      .tg-emulator-overlay-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 700;
      }

      .tg-emulator-overlay-badge {
        font-size: 11px;
        font-weight: 700;
        border-radius: 999px;
        padding: 2px 8px;
        color: #042a3f;
        background: #95e4ff;
      }

      .tg-emulator-overlay-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 4px;
        margin-bottom: 8px;
      }

      .tg-emulator-overlay-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      .tg-emulator-overlay-key {
        color: rgba(198, 225, 246, 0.85);
      }

      .tg-emulator-overlay-value {
        color: #ffffff;
        font-weight: 600;
      }

      .tg-emulator-overlay-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
      }

      .tg-emulator-overlay-btn {
        height: 34px;
        border: 0;
        border-radius: 10px;
        cursor: pointer;
        color: #032436;
        font-weight: 700;
        font-size: 12px;
        background: linear-gradient(140deg, #9cecff 0%, #74ceff 100%);
      }

      .tg-emulator-overlay-btn-secondary {
        background: linear-gradient(140deg, #d8e8f9 0%, #bacfe3 100%);
      }
    `,
  });

  await page.evaluate((params) => {
    const previous = document.querySelector('.tg-emulator-overlay');
    if (previous) previous.remove();

    const createRow = (label, initialValue) => {
      const row = document.createElement('div');
      row.className = 'tg-emulator-overlay-row';
      const key = document.createElement('span');
      key.className = 'tg-emulator-overlay-key';
      key.textContent = label;
      const value = document.createElement('span');
      value.className = 'tg-emulator-overlay-value';
      value.textContent = initialValue;
      row.appendChild(key);
      row.appendChild(value);
      return { row, value };
    };

    const root = document.createElement('aside');
    root.className = 'tg-emulator-overlay';

    const head = document.createElement('div');
    head.className = 'tg-emulator-overlay-head';
    const title = document.createElement('span');
    title.textContent = 'Telegram Mini App';
    const modeBadge = document.createElement('span');
    modeBadge.className = 'tg-emulator-overlay-badge';
    modeBadge.textContent = 'FULLSCREEN';
    head.appendChild(title);
    head.appendChild(modeBadge);

    const grid = document.createElement('div');
    grid.className = 'tg-emulator-overlay-grid';
    const viewportRow = createRow('Viewport', '-');
    const safeRow = createRow('Safe area', '-');
    const screenRow = createRow('Экран', String(params?.openScreen || 'home'));
    const versionRow = createRow('WebApp API', '-');
    grid.appendChild(viewportRow.row);
    grid.appendChild(safeRow.row);
    grid.appendChild(screenRow.row);
    grid.appendChild(versionRow.row);

    const actions = document.createElement('div');
    actions.className = 'tg-emulator-overlay-actions';

    const fullscreenButton = document.createElement('button');
    fullscreenButton.type = 'button';
    fullscreenButton.className = 'tg-emulator-overlay-btn';
    fullscreenButton.textContent = 'Fullscreen';

    const mainButtonToggle = document.createElement('button');
    mainButtonToggle.type = 'button';
    mainButtonToggle.className = 'tg-emulator-overlay-btn tg-emulator-overlay-btn-secondary';
    mainButtonToggle.textContent = 'MainButton';

    actions.appendChild(fullscreenButton);
    actions.appendChild(mainButtonToggle);

    if (params?.allowNonFullscreen) {
      const fullsizeButton = document.createElement('button');
      fullsizeButton.type = 'button';
      fullsizeButton.className = 'tg-emulator-overlay-btn tg-emulator-overlay-btn-secondary';
      fullsizeButton.textContent = 'Fullsize';
      fullsizeButton.addEventListener('click', () => {
        window.Telegram?.WebApp?.__emulator?.setMode?.('fullsize');
      });
      actions.appendChild(fullsizeButton);
    }

    root.appendChild(head);
    root.appendChild(grid);
    root.appendChild(actions);
    document.body.appendChild(root);

    const refresh = () => {
      const webApp = window.Telegram?.WebApp;
      const mode = webApp?.__emulator?.getMode?.() ||
        (webApp?.isFullscreen ? 'fullscreen' : webApp?.isExpanded ? 'fullsize' : 'compact');
      const safeTop = Number(webApp?.safeAreaInset?.top || 0);
      const safeBottom = Number(webApp?.safeAreaInset?.bottom || 0);
      const viewportH = Number(webApp?.viewportHeight || window.innerHeight);
      const viewportW = window.innerWidth;
      const mainVisible = Boolean(webApp?.MainButton?.isVisible);

      modeBadge.textContent = String(mode || 'fullscreen').toUpperCase();
      viewportRow.value.textContent = `${Math.round(viewportW)} x ${Math.round(viewportH)}`;
      safeRow.value.textContent = `top ${Math.round(safeTop)} / bottom ${Math.round(safeBottom)}`;
      versionRow.value.textContent = String(webApp?.version || '-');
      mainButtonToggle.textContent = mainVisible ? 'Hide MainBtn' : 'Show MainBtn';
    };

    fullscreenButton.addEventListener('click', () => {
      window.Telegram?.WebApp?.requestFullscreen?.();
    });
    mainButtonToggle.addEventListener('click', () => {
      const webApp = window.Telegram?.WebApp;
      if (webApp?.__emulator?.toggleMainButton) {
        webApp.__emulator.toggleMainButton();
      } else if (webApp?.MainButton?.isVisible) {
        webApp.MainButton.hide?.();
      } else {
        webApp?.MainButton?.show?.();
      }
      refresh();
    });

    const webApp = window.Telegram?.WebApp;
    if (webApp?.onEvent) {
      webApp.onEvent('viewportChanged', refresh);
      webApp.onEvent('fullscreenChanged', refresh);
      webApp.onEvent('safeAreaChanged', refresh);
      webApp.onEvent('contentSafeAreaChanged', refresh);
    }
    window.addEventListener('resize', refresh, { passive: true });
    refresh();
  }, {
    allowNonFullscreen: config.allowNonFullscreen,
    openScreen: config.openScreen,
  });
}

async function runEmulatorMode(runtime, config) {
  await openScreenById(runtime.page, config.waitMs, config.openScreen);
  await installEmulatorOverlay(runtime.page, config);

  console.log('[emulator] Telegram Mini App эмулятор запущен.');
  console.log(`[emulator] URL: ${runtime.page.url()}`);
  console.log(
    `[emulator] Режим viewport: ${config.tgMode}${
      config.mode === 'emulator' && !config.allowNonFullscreen ? ' (fullscreen lock)' : ''
    }`
  );
  console.log(`[emulator] Экран: ${config.openScreen}`);
  console.log('[emulator] Остановить: Ctrl+C');

  const browser = runtime.page.context().browser();
  const waitForBrowserDisconnect = browser
    ? new Promise((resolve) => {
        const handleDisconnect = () => {
          if (typeof browser.off === 'function') {
            browser.off('disconnected', handleDisconnect);
          }
          resolve();
        };
        if (typeof browser.on === 'function') {
          browser.on('disconnected', handleDisconnect);
        } else {
          resolve();
        }
      })
    : new Promise(() => {});

  await Promise.race([
    once(process, 'SIGINT'),
    waitForBrowserDisconnect,
  ]);
}

async function createRuntime(config) {
  let server = null;
  let baseUrl = config.baseUrl;

  if (!baseUrl) {
    server = await startDevServer(config.port);
    baseUrl = server.baseUrl;
    if (server.port !== config.port) {
      console.log(`[visual] Порт ${config.port} занят, использую ${server.port}.`);
    }
  }

  const browser = await chromium.launch({ headless: !config.headful });
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    locale: 'ru-RU',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();

  await blockUnstableAssets(page);
  await installTelegramMocks(page, config);
  if (config.mockApi) {
    await registerApiMocks(page);
  }

  const telegramMockQuery = buildTelegramMockQuery(config);
  await page.goto(`${baseUrl}/?${telegramMockQuery}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(APP_READY_SELECTOR, { timeout: 15_000 });
  await installTelegramChrome(page, config);
  await waitForFonts(page);
  if (config.mode !== 'emulator') {
    await disableMotion(page);
  }
  await sleep(config.waitMs);

  const cleanup = async () => {
    if (server?.child) {
      await stopDevServer(server.child);
    }
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };

  return { page, cleanup, baseUrl };
}

async function main() {
  const mode = process.argv[2];
  if (!mode || mode === '--help' || mode === '-h') {
    console.log(usage.trim());
    process.exit(0);
  }

  if (!SUPPORTED_MODES.has(mode)) {
    console.error(`Неизвестный режим: "${mode}"`);
    console.log(usage.trim());
    process.exit(1);
  }

  const rawArgs = parseArgs(process.argv.slice(3));
  const config = parseConfig(mode, rawArgs);

  if (
    mode === 'emulator' &&
    !config.allowNonFullscreen &&
    rawArgs.tgMode &&
    toTelegramMode(rawArgs.tgMode, DEFAULT_TG_MODE) !== 'fullscreen'
  ) {
    console.log('[emulator] Игнорирую --tgMode, включен fullscreen lock (use --allowNonFullscreen).');
  }

  if (mode === 'compare') {
    await runCompareMode(config);
    return;
  }

  const runtime = await createRuntime(config);

  try {
    if (mode === 'screenshot') {
      await runScreenshotMode(runtime.page, config);
    } else if (mode === 'scan') {
      await runScanMode(runtime.page, config);
    } else {
      await runEmulatorMode(runtime, config);
    }
  } finally {
    await runtime.cleanup();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
