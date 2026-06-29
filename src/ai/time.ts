const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 把 epoch 毫秒格式化为 UTC+8（北京时间）的 "YYYY-MM-DD HH:mm:ss"。
 * 通过先偏移 +8h 再读取 UTC 字段实现，结果与服务器本地时区无关。
 */
export function formatUtc8(ms: number): string {
  const d = new Date(ms + UTC8_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 当前 UTC+8 时间字符串，形如 "2026-06-29 13:21:48"。 */
export function nowUtc8(): string {
  return formatUtc8(Date.now());
}
