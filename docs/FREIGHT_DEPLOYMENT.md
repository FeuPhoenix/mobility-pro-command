# Deploying the freight module (W6)

What the host must provide, three ways to run it, and how to back it up. The
host itself is still to be chosen; nothing here assumes a particular provider.

---

## What the host must provide

| Need | Why |
| --- | --- |
| **Node 22.5 or later** (22 LTS recommended) | The store uses Node's built-in `node:sqlite` |
| **A long-running process** | The optional collection timer runs inside the server, and requests share one database |
| **A writable, persistent, backed-up disk** for `FREIGHT_DATA_DIR` | The SQLite database and attachments. An approval that does not survive a restart is not an approval |
| **HTTPS and a fixed address** | Sign-in (`AUTH_BASE_URL`) and the Microsoft redirect URI depend on it; session cookies are `Secure` over HTTPS |
| **Outbound HTTPS** to `login.microsoftonline.com`, `graph.microsoft.com` and the ERPNext site | Only for the integrations switched on |

**It does not work on read-only serverless hosting** (Vercel functions and
similar): the filesystem is read-only and requests may land on different
instances. The repository's `vercel.json` is for the stateless operations demo
only. Suitable: a small Linux VM, Azure App Service (Linux) with a persistent
volume mounted for the data folder, Railway, Fly.io or Render with a disk.

On Windows, keep `FREIGHT_DATA_DIR` short: SQLite cannot open a file whose
full path exceeds 260 characters, and `/api/health` will say so.

Run **one instance**. SQLite is a single-file database; two servers writing to
the same file over a network share is not supported. One instance of this size
handles a logistics team comfortably.

## Option 1: Docker

```bash
docker build -t mobility-pro-command .
docker run -d --name mpc -p 4310:4310 --env-file .env.local \
  -v freight-data:/app/data --restart unless-stopped mobility-pro-command
```

Or `cd deploy && docker compose up -d --build`, which also runs a daily backup
into `deploy/backups/`. The image runs as a non-root user, exposes port 4310,
and has a health check on `/api/health`. **The volume is essential**: without
it, replacing the container erases the store.

## Option 2: a plain Linux server (systemd)

```bash
sudo useradd --system --home /opt/mobility-pro-command freight
sudo mkdir -p /var/lib/mobility-pro-command /var/backups/mobility-pro-command
sudo chown freight /var/lib/mobility-pro-command /var/backups/mobility-pro-command
# as freight, in /opt/mobility-pro-command:
npm ci && npm run build
sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mobility-pro-command mobility-pro-command-backup.timer
```

Put a reverse proxy (nginx, Caddy) in front for HTTPS, forwarding to
`127.0.0.1:4310`.

## Option 3: a managed Node host

Build command `npm ci && npm run build`, start command
`npx next start -p $PORT` (or 4310), Node 22, a persistent disk mounted at the
path you set as `FREIGHT_DATA_DIR`, health check path `/api/health`.

## Configuration

Copy `.env.example` to `.env.local` on the server and fill in only what is
switched on; `docs/FREIGHT_GO_LIVE.md` says which values come from whom. At a
minimum for real use:

- `FREIGHT_DATA_DIR` on the persistent disk
- `AUTH_MODE=entra` and the `AUTH_*` values. **Never expose demo mode with real
  data**: anyone could act as anyone
- `AUTH_BASE_URL` = the public HTTPS address, and the same address in the
  sign-in app registration's redirect URI

Reply collection on a single server: `MAILBOX_POLL_SECONDS=120`. If the host
prefers its own scheduler, set `MAILBOX_COLLECT_TOKEN` and have it call
`POST /api/freight/collect` with `Authorization: Bearer <token>`.

## Health

`GET /api/health` returns 200 when the database opens and the data folder is
writable, 503 otherwise, and reveals no configuration or data. Point the host's
health check or uptime monitor at it.

## Backups

```bash
npm run backup -- /var/backups/mobility-pro-command 14
```

`scripts/backup.mjs` uses SQLite's online backup, so it is consistent while the
application is running, copies the attachments, and removes its own backups
older than the given number of days (it never touches other folders). Schedule
it daily (the systemd timer and the compose file above do), and **copy the
backup folder off the server**: a backup on the same disk does not survive
losing the disk.

**Restore:** stop the application; replace `freight.db` and `attachments/` in
`FREIGHT_DATA_DIR` with the ones from a backup folder; start it. Test a restore
once before relying on it.

## Updating

Pull the new version, `npm ci && npm run build` (or rebuild the image), restart.
Database changes are additive and applied automatically on start. Take a backup
first.

## The operations demo

The same application serves the older, stateless operations demo at `/`. It is
fictional and has no sign-in. Decide whether it should be reachable on the
production address; if not, block `/`, `/operations`, `/customers`,
`/approvals`, `/automations` and `/api/{action,assistant,reset,state}` at the
reverse proxy.

## Verified here, and not

| | |
| --- | --- |
| Production build and start from an empty data folder, `/api/health` 200 | Verified on Windows, Node 22 |
| Backup while the app holds the database open; restore reads back | Unit tested |
| Dockerfile, compose file, systemd units | **Written, not run**: Docker and Linux were not available in this environment. Build the image once before relying on it |
