# Mail Automation

A multi-tenant SaaS replacement for the Google Apps Script email system. Campaigns, contacts, templates, scheduling, three-level follow-ups, bounce cleanup and the daily digest — all in a React dashboard backed by PostgreSQL, sending through the Gmail API.

---

## What replaced what

| Apps Script | This application |
|---|---|
| `Main1`…`Main10` sheets | **Campaign** + **Contact** tables — unlimited campaigns, any number of columns |
| `Process` sheet (template + attachment picker) | Campaign settings: mailbox, delivery mode, default attachment |
| `AutoProcess` sheet row | A campaign's four **CampaignStep** records (Initial, FU1, FU2, FU3) |
| `Dashboard` sheet | Live dashboard with charts, funnel and per-campaign status |
| Google Drive template folder | **Template** table with a rich-text editor, live preview and version history |
| `createDraft` / `createDraftReply` | Gmail API `users.drafts.create`, with `threadId` + `In-Reply-To`/`References` |
| `buildTrimmedGmailChain` | `server/src/lib/quote.ts` — same trimmed-quote markup |
| `fetchSentThreadIds` | **Sync threads** button per campaign |
| `cleanBouncedEmails` | Reads real delivery-failure notices instead of guessing from substrings; marks contacts `BOUNCED` rather than deleting rows |
| 6:30 AM `ScriptApp` trigger | Per-workspace scheduler with its own timezone and run time |
| `MAX_EXECUTION_TIME_MS` chunking + `PropertiesService` | Database-backed run queue with a cursor — survives restarts, resumes automatically |
| `sendCampaignCompletionEmail` | Daily digest, sent once the day's runs settle |
| Single spreadsheet, single user | Organizations, memberships, roles, per-tenant isolation |
| — | Stripe subscriptions with server-enforced plan limits |

---

## Requirements

- Node.js 20+
- PostgreSQL 14+ (a local install, or a free hosted database from Neon or Supabase)
- A Google Cloud project with the Gmail API enabled

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the database

Create an empty database, then copy the environment template:

```bash
cp server/.env.example server/.env
```

Set `DATABASE_URL` in `server/.env` to your connection string, for example:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/mail_automation?schema=public"
```

Generate the two secrets and paste them into the same file:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex')); console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` encrypts stored OAuth tokens with AES-256-GCM. **Changing it later invalidates every connected mailbox**, which then has to be reconnected.

### 3. Create the tables

```bash
npm run db:push
```

Optionally load a demo workspace (1 campaign, 8 contacts, 4 templates):

```bash
npm run seed
```

Demo login: `demo@mailautomation.app` / `demo12345`

### 4. Connect Google OAuth

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project, then enable **Gmail API** under *APIs & Services → Library*.
2. Configure the **OAuth consent screen**. While it is in *Testing*, add the Gmail accounts you plan to connect as test users.
3. Create an **OAuth client ID** of type *Web application* with this authorised redirect URI:
   ```
   http://localhost:4000/api/mail-accounts/oauth/callback
   ```
4. Put the client ID and secret into `server/.env`.

Scopes requested: `gmail.modify`, `gmail.compose`, `userinfo.email`, `userinfo.profile`.

### 5. Connect Stripe (optional)

Skip this and everything runs on the Free plan; the billing page simply says billing is not configured.

1. In the [Stripe dashboard](https://dashboard.stripe.com/), copy your secret key into `STRIPE_SECRET_KEY`.
2. Create one **recurring monthly Price** per paid plan (*Products → Add product*), and put the price IDs into `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` and `STRIPE_PRICE_BUSINESS`. A plan with no price ID shows as unavailable rather than failing at checkout.
3. Forward webhooks while developing:
   ```bash
   stripe listen --forward-to localhost:4000/api/webhooks/stripe
   ```
   Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET`. In production, create the endpoint in the dashboard pointing at `https://your-domain/api/webhooks/stripe`.

Plan tiers and their limits live in `server/src/lib/plans.ts` — edit that file to change pricing or allowances.

### 6. Run

```bash
npm run dev
```

- Dashboard — http://localhost:5173
- API health — http://localhost:4000/api/health

---

## Using it

1. **Settings → Mailboxes** — connect the Gmail account you send from.
2. **Templates** — write your message. Any `{{Column Name}}` from your contact data is merged in; `{{First Name|there}}` supplies a fallback.
3. **Campaigns → New campaign** — pick the mailbox and choose the delivery mode:
   - *Create drafts for review* — mirrors the Apps Script behaviour; emails wait in Gmail Drafts.
   - *Send automatically* — sends the moment a step runs.
4. **Contacts → Import CSV** — every column header becomes a merge variable.
5. **Campaign → Sequence** — give each of the four steps a template and a date, then save.
6. Set the campaign status to **Active**. The scheduler queues any step dated today at your workspace's configured time.

**Test first contact** on any step creates a single email so you can check the merge output before committing to the whole list.

### Follow-ups and threading

Follow-up steps reply inside the existing conversation. The thread is found by the stored `threadId`, or by searching the mailbox for the contact's address and subject. If no conversation exists yet, that contact is skipped and logged — it is never sent as a fresh email by mistake.

If you sent your initial emails outside this app, run **Sync threads** on the campaign first so follow-ups know where to reply.

---

## Architecture

```
server/
  prisma/schema.prisma      Data model
  src/
    lib/
      plans.ts              Plan catalog — pricing and limits
      stripe.ts             Stripe client (optional at boot)
      gmail.ts              OAuth, drafts, thread search, bounce reading
      mime.ts               RFC 5322 message assembly (multipart + attachments)
      merge.ts              {{variable}} substitution, HTML escaping
      quote.ts              Gmail trimmed-quote chain
      crypto.ts             AES-256-GCM for OAuth tokens
    services/
      runner.ts             Campaign execution engine (chunked, resumable)
      scheduler.ts          Worker tick + per-workspace daily automation
      bounce.ts             Delivery-failure processing
      digest.ts             Daily summary email
      billing.ts            Stripe subscription sync
    middleware/plan.ts      Plan limit enforcement (402)
    routes/                 REST API (webhooks mounted pre-JSON)
web/
  src/
    pages/                  Dashboard, campaigns, templates, contacts, settings
    components/             Design system, editor, contacts panel, run log
```

### How a run works

1. A step is triggered manually, or the scheduler finds it dated today.
2. A `Run` row is created with `status: QUEUED` and a total contact count.
3. The worker picks it up and processes contacts in batches, saving a cursor after each one.
4. When the chunk budget (25s by default) is spent, the run yields and resumes on the next tick.
5. Hitting the workspace's daily limit pauses the run; it continues the next day.
6. On completion the step is marked `PROCESSED` and per-contact results are readable in the run log.

Because progress lives in the database, restarting the server mid-campaign loses nothing — interrupted runs are re-queued on boot.

---

## Multi-tenancy

Every tenant-scoped route resolves `req.orgId` from the caller's membership and filters on it. The browser sends the active workspace as an `X-Org-Id` header, but the header is never trusted on its own: the membership lookup is what authorises access.

Roles: **Owner** (full control), **Admin** (settings, mailboxes, teammates), **Member** (campaigns and contacts).

---

## Deploying

```bash
npm run build
```

Set `NODE_ENV=production` — `JWT_SECRET` and `ENCRYPTION_KEY` become mandatory rather than falling back to a development default. Update `APP_URL`, `API_URL` and `GOOGLE_REDIRECT_URI` to your real domain, and add that redirect URI to the Google OAuth client.

Serve `web/dist` as static files and run `npm start` for the API. Attachments are stored on local disk under `server/uploads`; point `UPLOAD_DIR` at a persistent volume, or swap `server/src/lib/storage.ts` for object storage.

---

## Billing and plan enforcement

| Plan | Price | Contacts | Emails/day | Mailboxes | Campaigns |
|---|---|---|---|---|---|
| Free | — | 500 | 100 | 1 | 3 |
| Starter | $29/mo | 5,000 | 500 | 3 | 25 |
| Pro | $79/mo | 25,000 | 2,000 | 10 | 200 |
| Business | $199/mo | 100,000 | 5,000 | 50 | 1,000 |

Limits are enforced server-side in `server/src/middleware/plan.ts`, not in the UI. Exceeding one returns **402** with the current count and the ceiling; the dashboard catches that status globally and offers the upgrade path. Checks run when creating a campaign, importing or adding contacts, connecting a mailbox, and before each chunk of a run.

Stripe is the source of truth. `applySubscription()` copies the plan's limits onto the workspace when a subscription changes, and an unrecognised price falls back to Free rather than granting access. Because the limits are stored per workspace rather than derived, you can raise them for a custom deal without touching the plan catalog.

Webhooks are verified by signature and made idempotent by a unique constraint on `BillingEvent.stripeEventId`, so Stripe's retries are harmless. The handler is mounted before `express.json()` so the raw body survives for signature checking.

Card details never touch this server — checkout and payment-method changes happen on Stripe's hosted pages.

## Notes on limits

Gmail caps API sending per account per day (2,000 for Workspace, 500 for consumer accounts). The workspace-level **Maximum emails per day** setting keeps runs inside whatever ceiling you set, pausing rather than failing when it is reached.
