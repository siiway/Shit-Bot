# AGENTS.md

## Environment

- **Runtime**: Bun (`packageManager: bun`). Always use `bun install`, `bun run <script>`.
- **Nix-first**: If the host lacks `bun`, `node`, etc., create or update `flake.nix` (`nix develop` / `nix shell`) instead of assuming global installs.
- **No npm/pnpm/yarn**.

## Commands

```bash
bun install          # install deps
bun run dev          # tsx src/index.ts (hot-reload dev server)
bun run build        # tsc && cp src/web/ui.html dist/web/ui.html
bun run start        # node dist/index.js
```

Build copies `src/web/ui.html` into `dist/web/` because tsc does not copy non-`.ts` assets.

## Architecture

- Single Node.js process, not serverless/Workers.
- `src/index.ts` — entrypoint: loads config → inits SQLite, Twitter client, Discord/Telegram bots, cron scheduler, web server.
- `src/config.ts` — config loader: reads first found file from `config.yaml > config.yml > config.toml > config.json`, merges env vars, validates.
- `src/storage.ts` — `better-sqlite3` (native C++ addon). Two tables: `sent_tweets`, `image_cache`. DB at `data/bot.db`.
- `src/bots/` — Discord (`discord.js`) and Telegram (`telegraf`) clients.
- `src/twitter/` — X/Twitter API via `twitter-openapi-typescript`; supports cookie auth or username/password login with TOTP.
- `src/approval.ts` — multi-admin approval flow (Telegram inline keyboard + Discord buttons).
- `src/web/server.ts` — HTTP server on configurable port (default 3000). Serves `ui.html` + REST API for config CRUD.
- Config secrets are **never committed** — `config.yaml/json/toml` are in `.gitignore`.

## Key gotchas

- `better-sqlite3` is a **native C++ module** — requires a C++ toolchain. Bun handles native modules; Node requires `node-gyp`.
- Config file format is auto-detected by extension. Saving always writes back in the same format (YAML or JSON).
- When editing config via API, masked secrets (`••••••••`) are treated as "no change" — the existing value is preserved.
- Web UI: `fetchAllTweets` is defined in both `src/twitter/client.ts` and `src/rss/fetcher.ts`. The one used is from `twitter/client.ts` (imported in `index.ts`).

## TypeScript conventions

- Use `const`, never `var`.
- Avoid `any`; narrow types first, then use explicit assertions.
- Prefer `type` over `interface` unless declaration merging is needed.
- No `enum` — use literal unions.
- Public API functions must declare return types explicitly.
- Files: `kebab-case.ts`.
- Keep imports in a consistent order; the repo has no ESLint/Prettier config yet — match existing import style.
