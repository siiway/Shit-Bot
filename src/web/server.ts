import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, saveConfig, reloadConfig } from '../config';
import { getRecentTweets, getSentCount } from '../storage';
import { AppConfig, UserConfig } from '../types';

interface IncomingMessage extends http.IncomingMessage {
  body?: string;
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { req.body = data; resolve(data); });
  });
}

function sendJSON(res: http.ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, message: string, status = 400): void {
  sendJSON(res, { error: message }, status);
}

function checkAuth(req: IncomingMessage): boolean {
  const cfg = getConfig();
  if (!cfg.webui.password) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const encoded = auth.replace('Basic ', '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  const [, password] = decoded.split(':');
  return password === cfg.webui.password;
}

function requireAuth(_req: IncomingMessage, res: http.ServerResponse): boolean {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="ShitBot WebUI"',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function sanitizeConfigForAPI(cfg: AppConfig): any {
  return {
    users: cfg.users,
    discord: { ...cfg.discord, token: cfg.discord.token ? '••••••••' : '' },
    telegram: { ...cfg.telegram, token: cfg.telegram.token ? '••••••••' : '' },
    twitter: {
      ...cfg.twitter,
      authToken: cfg.twitter.authToken ? '••••••••' : '',
      ct0: cfg.twitter.ct0 ? '••••••••' : '',
      password: cfg.twitter.password ? '••••••••' : '',
      totpSecret: cfg.twitter.totpSecret ? '••••••••' : '',
    },
    webui: { ...cfg.webui, password: cfg.webui.password ? '••••••••' : '' },
    enableApproval: cfg.enableApproval,
    sendAsImage: cfg.sendAsImage,
    xToImageApiUrl: cfg.xToImageApiUrl,
    xToImageApiToken: cfg.xToImageApiToken ? '••••••••' : '',
    xToImageApiTheme: cfg.xToImageApiTheme,
    imageCacheTtlMinutes: cfg.imageCacheTtlMinutes,
    pollIntervalMinutes: cfg.pollIntervalMinutes,
    maxPostsPerFetch: cfg.maxPostsPerFetch,
    maxTweetAgeMinutes: cfg.maxTweetAgeMinutes,
  };
}

function serveUI(res: http.ServerResponse): void {
  const uiPath = path.join(__dirname, 'ui.html');
  try {
    const html = fs.readFileSync(uiPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>ShitBot</title></head><body><h1>UI file not found</h1></body></html>`);
  }
}

async function handleAPI(req: IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  if (!checkAuth(req)) {
    requireAuth(req, res);
    return;
  }

  await parseBody(req);

  try {
    if (req.method === 'GET' && urlPath === '/api/config') {
      const cfg = getConfig();
      sendJSON(res, sanitizeConfigForAPI(cfg));
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/config/full') {
      sendJSON(res, getConfig());
      return;
    }

    if (req.method === 'PUT' && urlPath === '/api/config') {
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();

      if (body.users !== undefined) cfg.users = body.users;
      if (body.discord !== undefined) {
        cfg.discord = { ...cfg.discord, ...body.discord };
        if (body.discord.token === '••••••••' || body.discord.token === '') {
          delete (body.discord as any).token;
        }
        if (body.discord.token && body.discord.token !== '••••••••' && body.discord.token !== cfg.discord.token) {
          cfg.discord.token = body.discord.token;
        }
      }
      if (body.telegram !== undefined) {
        cfg.telegram = { ...cfg.telegram, ...body.telegram };
        if (body.telegram.token && body.telegram.token !== '••••••••' && body.telegram.token !== cfg.telegram.token) {
          cfg.telegram.token = body.telegram.token;
        }
      }
      if (body.twitter !== undefined) {
        cfg.twitter = { ...cfg.twitter, ...body.twitter };
        if (body.twitter.authToken && body.twitter.authToken !== '••••••••') cfg.twitter.authToken = body.twitter.authToken;
        if (body.twitter.ct0 && body.twitter.ct0 !== '••••••••') cfg.twitter.ct0 = body.twitter.ct0;
        if (body.twitter.password && body.twitter.password !== '••••••••') cfg.twitter.password = body.twitter.password;
        if (body.twitter.totpSecret && body.twitter.totpSecret !== '••••••••') cfg.twitter.totpSecret = body.twitter.totpSecret;
      }
      if (body.webui !== undefined) {
        cfg.webui = { ...cfg.webui, ...body.webui };
        if (body.webui.password && body.webui.password !== '••••••••') cfg.webui.password = body.webui.password;
      }
      if (body.enableApproval !== undefined) cfg.enableApproval = body.enableApproval;
      if (body.sendAsImage !== undefined) cfg.sendAsImage = body.sendAsImage;
      if (body.xToImageApiUrl !== undefined) cfg.xToImageApiUrl = body.xToImageApiUrl;
      if (body.xToImageApiToken !== undefined && body.xToImageApiToken !== '••••••••') cfg.xToImageApiToken = body.xToImageApiToken;
      if (body.xToImageApiTheme !== undefined) cfg.xToImageApiTheme = body.xToImageApiTheme;
      if (body.imageCacheTtlMinutes !== undefined) cfg.imageCacheTtlMinutes = body.imageCacheTtlMinutes;
      if (body.pollIntervalMinutes !== undefined) cfg.pollIntervalMinutes = body.pollIntervalMinutes;
      if (body.maxPostsPerFetch !== undefined) cfg.maxPostsPerFetch = body.maxPostsPerFetch;
      if (body.maxTweetAgeMinutes !== undefined) cfg.maxTweetAgeMinutes = body.maxTweetAgeMinutes;

      saveConfig(cfg);
      sendJSON(res, { success: true });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/users') {
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();

      if (!body.username) {
        sendError(res, 'Username is required');
        return;
      }

      if (cfg.users.find(u => u.username === body.username)) {
        sendError(res, 'User already exists');
        return;
      }

      const user: UserConfig = {
        username: body.username,
        displayName: body.displayName || body.username,
        filters: body.filters || {},
      };

      cfg.users.push(user);
      saveConfig(cfg);
      sendJSON(res, { success: true, user });
      return;
    }

    if (req.method === 'DELETE' && urlPath.startsWith('/api/users/')) {
      const username = urlPath.replace('/api/users/', '');
      const cfg = getConfig();
      const idx = cfg.users.findIndex(u => u.username === username);

      if (idx === -1) {
        sendError(res, 'User not found', 404);
        return;
      }

      cfg.users.splice(idx, 1);
      saveConfig(cfg);
      sendJSON(res, { success: true });
      return;
    }

    if (req.method === 'PUT' && urlPath.startsWith('/api/users/')) {
      const username = urlPath.replace('/api/users/', '');
      const body = JSON.parse(req.body || '{}');
      const cfg = getConfig();
      const user = cfg.users.find(u => u.username === username);

      if (!user) {
        sendError(res, 'User not found', 404);
        return;
      }

      if (body.displayName !== undefined) user.displayName = body.displayName;
      if (body.filters !== undefined) user.filters = body.filters;

      saveConfig(cfg);
      sendJSON(res, { success: true, user });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/tweets') {
      const url = new URL(req.url || '', 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const tweets = getRecentTweets(limit);
      sendJSON(res, tweets);
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/stats') {
      const cfg = getConfig();
      sendJSON(res, {
        userCount: cfg.users.length,
        sentCount: getSentCount(),
        pollInterval: cfg.pollIntervalMinutes,
        discordEnabled: cfg.discord.enabled,
        telegramEnabled: cfg.telegram.enabled,
        approvalEnabled: cfg.enableApproval,
      });
      return;
    }

    sendError(res, 'Not found', 404);
  } catch (error) {
    console.error('API error:', error);
    sendError(res, 'Internal server error', 500);
  }
}

export function startWebServer(): http.Server {
  const cfg = getConfig();

  if (!cfg.webui.enabled) {
    console.log('WebUI is disabled');
    const dummy = http.createServer();
    return dummy;
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const urlPath = url.split('?')[0];

    if (urlPath === '/' || urlPath === '/index.html') {
      serveUI(res);
      return;
    }

    if (urlPath.startsWith('/api/')) {
      await handleAPI(req, res, urlPath);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(cfg.webui.port, cfg.webui.host, () => {
    console.log(`\nWebUI available at http://${cfg.webui.host}:${cfg.webui.port}`);
    if (cfg.webui.password) {
      console.log('WebUI password protection enabled');
    }
  });

  return server;
}
