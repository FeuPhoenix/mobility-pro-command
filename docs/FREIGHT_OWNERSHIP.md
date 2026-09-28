# Freight RFQ — who owns what

Fill this in before the handover is signed, and keep it current. It records
**who** holds each thing and **when it expires**, never the secret itself:
secrets live only in `.env.local` on the server (or the host's secret store).

---

## People

| Responsibility | Name | Contact | Backup person |
| --- | --- | --- | --- |
| Business owner (decides scope, signs off) | | | |
| Logistics Operations Manager(s) — approve email | | | |
| Runs the server (updates, restarts, logs) | | | |
| Microsoft 365 administrator | | | |
| ERPNext administrator | | | |
| Checks backups and runs the restore test | | | |
| First call when a quotation will not parse | | | |
| Maintains the code | | | |

## Access

| Access to | Held by | Notes |
| --- | --- | --- |
| Git repository (`FeuPhoenix/mobility-pro-command`) | | Who may merge to `main` |
| The host / server | | SSH, console or portal |
| Domain and TLS certificate | | Renewal date: |
| n8n instance (if used) | | |
| Teams channel for notifications | | |

## Secrets and their expiry

A client secret that expires stops that part working on the day it expires,
with no warning beforehand. Put each expiry in someone's calendar a month
ahead.

| Secret (environment variable) | Created in | Created by | Created on | **Expires on** | Stored where |
| --- | --- | --- | --- | --- | --- |
| `GRAPH_CLIENT_SECRET` (email) | Entra ID → App registrations | | | | |
| `AUTH_ENTRA_CLIENT_SECRET` (sign-in) | Entra ID → App registrations | | | | |
| `AUTH_SESSION_SECRET` | Generated (32+ random characters) | | | Does not expire; changing it signs everyone out | |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | ERPNext → the integration user | | | | |
| `FREIGHT_AUTOMATION_TOKEN` / `MAILBOX_COLLECT_TOKEN` | Generated | | | Rotate yearly | |
| `TEAMS_WEBHOOK_URL` | Teams channel → Connectors | | | | |
| `ANTHROPIC_API_KEY` (only if AI is authorised) | Anthropic console | | | | |

The administrator key used once to create the ERPNext DocType
(`ERPNEXT_ADMIN_API_KEY`) must **not** stay on the server.

## Backups

| | |
| --- | --- |
| Schedule (e.g. nightly 02:30) | |
| Command | `npm run backup -- --out=<folder> --keep=14` |
| Where the off-server copy goes | |
| Last restore test (`npm run restore -- --from=<file> --check`) | Date: ______ Result: ______ |

## When something goes wrong

| Situation | First step |
| --- | --- |
| A provider's quotation is read wrongly | Correct it on the quote screen (the correction is kept), then report the format to the code maintainer with the `.eml`, so a parser test is added |
| Email stopped sending | Settings → Connections → *Check connection*. Most often an expired `GRAPH_CLIENT_SECRET` |
| Nobody can sign in | Check `AUTH_ENTRA_CLIENT_SECRET` expiry and `AUTH_BASE_URL` |
| ERPNext records failing | Settings → Connections → ERPNext → *Check connection*; it lists what is missing |
| The server will not start or `/api/freight/health` is 503 | Check the data folder is mounted and writable, then the server log |
| Need to go back to yesterday | Stop the app, `npm run restore -- --from=<backup> --yes`, start it. The replaced data is kept beside it |
