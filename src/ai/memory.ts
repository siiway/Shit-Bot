import { getDatabase } from '../storage';
import { getConfig } from '../config';
import { formatUtc8 } from './time';

export interface MemoryRow {
  id: number;
  platform: string;
  username: string;
  key: string;
  value: string;
  weight: number;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number | null;
}

let tablesReady = false;

function ensureTables(): void {
  if (tablesReady) return;
  const db = getDatabase();

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'discord',
      username TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      UNIQUE(platform, username, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'discord',
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_ai_memories_user ON ai_memories(platform, username)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ai_memories_weight ON ai_memories(platform, username, weight)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(platform, username, created_at)');

  tablesReady = true;
}

function clampWeight(w: unknown): number {
  const n = typeof w === 'number' ? w : parseFloat(String(w));
  if (!isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normalizeKey(key: string): string {
  return String(key).trim().slice(0, 80).toLowerCase().replace(/\s+/g, '_');
}

export function saveMemory(
  platform: string,
  username: string,
  key: string,
  value: string,
  weight?: number
): { action: 'created' | 'updated'; key: string } {
  ensureTables();
  const db = getDatabase();
  const normKey = normalizeKey(key);
  const val = String(value).trim().slice(0, 2000);
  const now = Date.now();
  const w = weight === undefined ? 0.5 : clampWeight(weight);

  const existing = db
    .query('SELECT id FROM ai_memories WHERE platform = ? AND username = ? AND key = ?')
    .get(platform, username, normKey) as { id: number } | undefined;

  if (existing) {
    db.run(
      'UPDATE ai_memories SET value = ?, weight = ?, updated_at = ? WHERE id = ?',
      [val, w, now, existing.id]
    );
    return { action: 'updated', key: normKey };
  }

  db.run(
    `INSERT INTO ai_memories (platform, username, key, value, weight, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [platform, username, normKey, val, w, now, now]
  );
  return { action: 'created', key: normKey };
}

export function updateMemory(
  platform: string,
  username: string,
  key: string,
  value?: string,
  weight?: number
): 'updated' | 'not-found' | 'no-fields' {
  ensureTables();
  const db = getDatabase();
  const normKey = normalizeKey(key);
  const existing = db
    .query('SELECT id FROM ai_memories WHERE platform = ? AND username = ? AND key = ?')
    .get(platform, username, normKey) as { id: number } | undefined;
  if (!existing) return 'not-found';

  const sets: string[] = [];
  const params: any[] = [];
  if (value !== undefined) {
    sets.push('value = ?');
    params.push(String(value).trim().slice(0, 2000));
  }
  if (weight !== undefined) {
    sets.push('weight = ?');
    params.push(clampWeight(weight));
  }
  if (sets.length === 0) return 'no-fields';
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(existing.id);

  db.run(`UPDATE ai_memories SET ${sets.join(', ')} WHERE id = ?`, params);
  return 'updated';
}

export function deleteMemory(platform: string, username: string, key: string): boolean {
  ensureTables();
  const db = getDatabase();
  const normKey = normalizeKey(key);
  const res = db.run('DELETE FROM ai_memories WHERE platform = ? AND username = ? AND key = ?', [
    platform,
    username,
    normKey,
  ]);
  return res.changes > 0;
}

export function buildProfile(platform: string, username: string): string | null {
  ensureTables();
  const cfg = getConfig().ai.memory;
  const maxItems = cfg?.maxProfileItems ?? 12;
  const maxChars = cfg?.maxProfileChars ?? 800;

  const rows = getDatabase()
    .query(
      `SELECT key, value, weight FROM ai_memories
       WHERE platform = ? AND username = ?
       ORDER BY weight DESC, updated_at DESC
       LIMIT ?`
    )
    .all(platform, username, maxItems) as Array<{ key: string; value: string; weight: number }>;

  if (rows.length === 0) return null;

  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = `- ${r.value.replace(/\s*[\r\n]+\s*/g, ' ')}`;
    if (used + line.length > maxChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

export function getRecentConversation(
  platform: string,
  username: string,
  limit: number
): Array<{ role: 'user' | 'assistant'; content: string; created_at: number }> {
  if (limit <= 0) return [];
  ensureTables();
  const rows = getDatabase()
    .query(
      `SELECT role, content, created_at FROM ai_conversations
       WHERE platform = ? AND username = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(platform, username, limit) as Array<{
    role: 'user' | 'assistant';
    content: string;
    created_at: number;
  }>;
  return rows.reverse();
}

function escapeLike(token: string): string {
  return `%${token.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

function tokenizeQuery(query: string): string[] {
  const raw = String(query || '')
    .split(/[\s,，、;；/|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return Array.from(new Set(raw)).slice(0, 8);
}

function countHits(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const t of tokens) {
    if (lower.includes(t.toLowerCase())) n++;
  }
  return n;
}

function formatConv(rows: Array<{ role: string; content: string; created_at: number }>): string {
  return rows
    .map((r) => {
      const who = r.role === 'user' ? '对方' : '你';
      const when = formatUtc8(r.created_at);
      return `- (${when}) ${who}: ${r.content.slice(0, 200)}`;
    })
    .join('\n');
}

export function recallMemories(
  platform: string,
  username: string,
  query: string,
  limit?: number
): string {
  ensureTables();
  const db = getDatabase();
  const lim = limit ?? getConfig().ai.memory?.recallLimit ?? 8;
  const tokens = tokenizeQuery(query);

  type ConvRow = { role: string; content: string; created_at: number };
  type MemRow = { id: number; key: string; value: string; weight: number };

  // 空查询: 返回最近的对话历史 (画像里已有 KV, 这里专门补"我们聊过什么")
  if (tokens.length === 0) {
    const rows = db
      .query(
        `SELECT role, content, created_at FROM ai_conversations
         WHERE platform = ? AND username = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(platform, username, lim) as ConvRow[];
    if (rows.length === 0) return '暂无历史对话记录。';
    rows.reverse();
    return '最近的对话历史:\n' + formatConv(rows);
  }

  // 带关键词: 搜历史对话 + 没挤进画像的溢出记忆
  const convOrs = tokens.map(() => `content LIKE ? ESCAPE '\\'`).join(' OR ');
  const convRows = (
    db
      .query(
        `SELECT role, content, created_at FROM ai_conversations
         WHERE platform = ? AND username = ? AND (${convOrs})
         ORDER BY created_at DESC LIMIT 100`
      )
      .all(platform, username, ...tokens.map(escapeLike)) as ConvRow[]
  )
    .map((r) => ({ r, score: countHits(r.content, tokens) }))
    .sort((a, b) => b.score - a.score || b.r.created_at - a.r.created_at)
    .slice(0, lim)
    .map((x) => x.r);

  const memOrs = tokens.map(() => `(value LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')`).join(' OR ');
  const memParams: any[] = [platform, username];
  for (const t of tokens) {
    const p = escapeLike(t);
    memParams.push(p, p);
  }
  const memRows = (
    db
      .query(
        `SELECT id, key, value, weight FROM ai_memories
         WHERE platform = ? AND username = ? AND (${memOrs})
         ORDER BY weight DESC, updated_at DESC LIMIT 100`
      )
      .all(...memParams) as MemRow[]
  )
    .map((r) => ({ r, score: countHits(`${r.key} ${r.value}`, tokens) }))
    .sort((a, b) => b.score - a.score || b.r.weight - a.r.weight)
    .slice(0, lim)
    .map((x) => x.r);

  if (memRows.length > 0) {
    const ids = memRows.map((r) => r.id);
    db.run(
      `UPDATE ai_memories SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [Date.now(), ...ids]
    );
  }

  const parts: string[] = [];
  if (convRows.length > 0) {
    parts.push('相关历史对话片段:\n' + formatConv(convRows));
  }
  if (memRows.length > 0) {
    parts.push('相关记忆:\n' + memRows.map((r) => `- [${r.key}] ${r.value}`).join('\n'));
  }

  if (parts.length === 0) {
    return `没有找到与「${tokens.join(' ')}」相关的历史或记忆。`;
  }
  return parts.join('\n\n');
}

export function logConversation(
  platform: string,
  username: string,
  role: 'user' | 'assistant',
  content: string
): void {
  const cfg = getConfig().ai.memory;
  if (!cfg?.enabled || cfg.logConversations === false) return;
  const text = String(content || '').trim();
  if (!text) return;

  ensureTables();
  const db = getDatabase();
  db.run(
    'INSERT INTO ai_conversations (platform, username, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [platform, username, role, text.slice(0, 4000), Date.now()]
  );

  const maxKeep = cfg.maxConversationsPerUser ?? 500;
  db.run(
    `DELETE FROM ai_conversations
     WHERE platform = ? AND username = ? AND id NOT IN (
       SELECT id FROM ai_conversations WHERE platform = ? AND username = ?
       ORDER BY created_at DESC LIMIT ?
     )`,
    [platform, username, platform, username, maxKeep]
  );
}

export function listMemories(
  platform: string,
  username: string
): Array<{ key: string; value: string; weight: number }> {
  ensureTables();
  return getDatabase()
    .query(
      `SELECT key, value, weight FROM ai_memories
       WHERE platform = ? AND username = ?
       ORDER BY weight DESC, updated_at DESC`
    )
    .all(platform, username) as Array<{ key: string; value: string; weight: number }>;
}

export function getMemoryCount(platform: string, username: string): number {
  ensureTables();
  const row = getDatabase()
    .query('SELECT COUNT(*) as c FROM ai_memories WHERE platform = ? AND username = ?')
    .get(platform, username) as { c: number };
  return row.c;
}