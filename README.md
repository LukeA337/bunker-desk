# Stemline Bunker Desk

Back-to-back bunker trading desk: watches an Outlook mailbox, parses vendor quotes in any format,
normalizes them to true delivered cost, and sends the client quote as a threaded reply.

Stack: Next.js (App Router) · Microsoft Graph (delegated) · Neon Postgres · Claude Opus 5 · Vercel.

---

## Part 1 — Entra app registration (do this first)

This is the long pole. Start it before anything else; the rest takes minutes.

1. **Azure Portal** → **Microsoft Entra ID** → **App registrations** → **New registration**
2. **Name:** `Stemline Bunker Desk`
3. **Supported account types:** *Accounts in this organizational directory only (single tenant)*
4. **Redirect URI:** platform **Web**, value `http://localhost:3000/api/auth/callback`
   (add the Vercel one later: `https://<your-app>.vercel.app/api/auth/callback`)
5. **Register.** From the Overview page copy:
   - **Application (client) ID** → `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
6. **Certificates & secrets** → **New client secret** → copy the **Value** (not the Secret ID)
   → `AZURE_CLIENT_SECRET`. It is shown once.
7. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**,
   add all of:

   | Permission | Why |
   |---|---|
   | `offline_access` | refresh tokens, so the desk survives a restart |
   | `User.Read` | identify the signed-in trader |
   | `Mail.Read` | the delta poll |
   | `Mail.Send` | send the client quote |
   | `Mail.ReadWrite` | `createReply` builds a draft before sending |

8. **Grant admin consent** if the button is available. Delegated mail scopes are user-consentable in
   many tenants, but plenty of corporate tenants disable user consent — if sign-in later fails with
   `AADSTS65001`, that is what happened, and an admin needs to click this once.

> **Production note, not needed now.** For the shared purchasing-centre mailbox you would add
> *application* permissions instead and have an Exchange admin scope them to that one mailbox with
> **RBAC for Applications in Exchange Online**. That is the answer to "can this app read all our
> mail" — no. App RBAC replaced the older `New-ApplicationAccessPolicy` mechanism.

---

## Part 2 — Database (2 minutes, free)

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the connection string → `DATABASE_URL`.
3. Run the schema:

```bash
psql "$DATABASE_URL" -f schema.sql
```

No psql? Paste `schema.sql` into Neon's SQL Editor.

---

## Part 3 — Anthropic API key

Get one at [console.anthropic.com](https://console.anthropic.com) → `ANTHROPIC_API_KEY`.

Budget sanity: a vendor quote is roughly 500 input / 400 output tokens, so Claude Opus 5 costs about
**1.3 cents per quote parsed**. A busy desk day is a few dollars.

---

## Part 4 — Run it

```bash
cp .env.example .env.local   # fill in the five values
npm install
npm run dev
```

Open http://localhost:3000, click **Connect Outlook**, sign in.

### Deploy to Vercel (free)

```bash
npx vercel
```

Then in the Vercel dashboard add the same five environment variables, and add
`https://<your-app>.vercel.app/api/auth/callback` as a redirect URI in the Entra app registration
(step 4 above). Redeploy.

---

## How the watcher works, and why

Microsoft documents change-notification latency for Outlook messages as **average under 1 minute,
maximum 3 minutes**. Against a 10-minute quote validity that is unusable, so this app does **not**
use webhooks. It runs a **delta query** (`/mailFolders('inbox')/messages/delta`) and holds the delta
token between calls, so each poll returns only what is new.

In this prototype the poll is **driven by the open browser tab**, every 12 seconds. That is a
deliberate choice: it needs no always-on process, so it runs on a free Vercel plan, and it matches
reality — nobody is quoting a stem when nobody is at the screen.

**To make it a true 24/7 watcher** move the loop server-side: the same `pollMailbox()` in
`src/lib/graph.ts` called from a `setInterval` in a long-lived container (Railway, Fly, or Azure
Container Apps). Nothing else changes. That is the one thing to swap before this is production.

---

## What is deliberately not built

- **Credit / counterparty exposure checks.** A production desk must gate quoting on credit before
  a price goes out. Flag this early — their risk function will ask.
- **PDF / XLSX attachment parsing.** Graph returns attachments; extracting quotes from them is its
  own project.
- **Multi-currency hedging.** FX rates are configured per enquiry, not live.

---

## Layout

```
src/lib/engine.ts   deterministic pricing — no LLM, fully unit-tested (npm test)
src/lib/graph.ts    Microsoft Graph: delta poll, message fetch, createReply + send
src/lib/auth.ts     MSAL confidential client, auth-code flow, refresh-token storage
src/lib/parse.ts    Claude Opus 5, structured outputs, one call per vendor block
src/lib/db.ts       Neon Postgres
src/app/api/…       signin · callback · poll · parse · send
```

The pricing engine is the part that must never be wrong, so it is pure, deterministic and tested
separately from everything else. `npm test` runs it.
