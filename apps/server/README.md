# Self-hosted Server

**English** · [中文](README.zh.md)

A single-account Remote relay with credentials configured through environment variables. Ocean provides an independently authored, minimal Russian sign-in and device-status console. The Server is deployed separately from the Host plugin bundle.

## Self-hosted Web flow

The `/`, `/app/login`, and `/app/remote` routes open the same console; its content is determined by the authenticated Cookie session. A successful sign-in updates the URL to `/app/remote`. Point both Host and Client at the same Server URL and use the same account and password. Device credentials are persisted by the Server, while Web sessions use an HttpOnly cookie.

Ocean fork: see the [Russian self-hosting guide](../../docs/self-host-ocean.ru.md) for a standalone HTTPS/Caddy Compose configuration. The Ocean plugin has no default server address. The previously borrowed server UI and images have been replaced; see [provenance](web/UPSTREAM.md). Dependency/artifact licensing review is still separate.

## Docker deployment

```bash
cd apps/server
cp .env.example .env
# Edit .env: set your account, password, and public URL
docker compose up -d --build
```

Open <http://localhost:8080>. Device credentials persist in the `server-data` volume. Stop the service with `docker compose down`.

The GitHub Tag workflow builds the production image. Put an HTTPS reverse proxy in front of it instead of exposing the Node listener directly to the public internet.

## Local setup

Requires Node.js 22 and pnpm 9.15.4. From the repository root:

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` with your account and a password of at least 12 characters, then start:

```bash
cd apps/server
node --env-file=.env dist/main.js
```

Open <http://localhost:8080>. Set the same Server URL on your Host and Client, then sign in with the same account. Use an email address as the account name for compatibility with existing clients.

| Variable | Purpose / default |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Required login account |
| `DSH_SERVER_PASSWORD` | Required; at least 12 characters |
| `DSH_SERVER_PUBLIC_URL` | Browser-facing URL; default `http://localhost:8080` |
| `DSH_SERVER_HOST` | Listen / port-binding address; default `127.0.0.1`, use `0.0.0.0` for LAN access |
| `DSH_SERVER_PORT` | Default `8080` |
| `DSH_SERVER_DATA_FILE` | Default `data/state.json`, relative to the working directory |

For public access, use an HTTPS reverse proxy and set `DSH_SERVER_PUBLIC_URL` to your domain. The proxy must support WebSocket Upgrade at `/ws/v1/connect` with an idle timeout above 75 seconds.

## Production artifact and license notices

From the repository root, after the builds above:

```sh
mkdir -p .local
node apps/server/scripts/package-server.mjs .local/server-release
node apps/server/scripts/smoke-deploy.mjs .local/server-release
```

The destination must be new; the packager never overwrites an existing deployment. Do not use `pnpm deploy` for this server: pnpm 9 in this workspace also copies unrelated root-plugin dependencies. The audited packager includes only the built console/server, internal protocol package, ws and zod. Run the smoke check on the same Node 22 used for deployment. It starts temporary loopback processes, uses random throwaway credentials, tests authentication and restart persistence, then removes its own temporary state; it does not use a DSH profile.

The build copies full project and seven audited third-party licenses into `dist/LICENSE`, `dist/THIRD_PARTY_NOTICES.txt`, and `dist/public/THIRD_PARTY_NOTICES.txt`. The latter is available through the console's **Лицензии** link. Dependency-version changes or newly installed optional peers require another audit and fail the notices build until reviewed. Node/OS image licenses are outside this application-level inventory. Docker build, runtime user/volume behavior and HTTPS still require actual container validation; a local artifact smoke check does not establish them.

## Features

- Device registration, credential refresh, device discovery, Control, and end-to-end encrypted Relay.
- Single-process operation with persistent data. Device credentials survive restarts; Web users sign in again. Changing the password requires devices to reauthorize.

Tests: `pnpm --filter @dsh-remote/server test`. Cross-machine and long-running validation remain pending. UI sources: [web/UPSTREAM.md](web/UPSTREAM.md).

## Release Tag checks

A release tag must match the versions in the root `package.json` and `packages/plugin/package.json` (currently `0.5.13`), for example `v0.5.13`. The Tag workflow runs workspace checks, tests, builds, npm plugin packing, browser-extension packaging, and SHA256 checksums; the Server image is built from the same tag.

Run the checks locally before creating a tag:

```bash
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm -r test
NODE_ENV=production pnpm -r build
node scripts/verify-dsh-plugin.mjs
pnpm --dir packages/plugin pack --pack-destination /tmp/dsh-release-assets
```
