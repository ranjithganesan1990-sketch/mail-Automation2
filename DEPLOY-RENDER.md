# Deploying Mail Automation to Render

The whole app ships as **one Render Web Service plus one Render Postgres**.
Set up below by hand in the Render dashboard, on the **free tier** for testing.
Read [Free-tier limits](#free-tier-limits) before trusting it with real
campaigns, and [Going to production](#going-to-production) when you are ready.
The Express server serves the built React dashboard from the same origin, so
there is no second hostname, no CORS config, and no `VITE_API_URL` to keep in
sync — the dashboard's relative `/api/...` calls just work.

```
  https://<your-service>.onrender.com
        |
        |--  /            -> web/dist  (React SPA)
        |--  /assets/*    -> hashed JS/CSS, cached 1 year
        \--  /api/*       -> Express API + node-cron scheduler
                              |
                              \-- Render Postgres (private network)
```

---

## 1. Push the repo

```bash
git add -A
git commit -m "Add Render deployment"
git push origin main
```

## 2. Create the Postgres database

Render Dashboard -> **New +** -> **Postgres**

| Field | Value |
| --- | --- |
| Name | `mail-automation-db` |
| Database | `mail_automation` |
| User | `mail_automation` |
| Region | **Singapore** (or nearest — must match the web service) |
| Version | 16 |
| Instance Type | **Free** |

Create it and wait for status **Available** (about a minute). Then open the
database page and copy the **Internal Database URL** — it starts with
`postgresql://` and contains `...-a` (no public hostname). Keep that tab open.

> Use the *Internal* URL, not the External one. Internal traffic stays on
> Render's private network: faster, free of egress, and it needs no SSL
> parameters. It only works because the web service is in the same region.

## 3. Create the Web Service

Render Dashboard -> **New +** -> **Web Service** -> connect your GitHub repo.

| Field | Value |
| --- | --- |
| Name | `mail-automation` |
| Language / Runtime | **Node** |
| Branch | `main` |
| Region | **same as the database** |
| Root Directory | *leave blank* |
| Build Command | `npm install --include=dev && npm run db:generate && npm run build` |
| Start Command | `npm run db:deploy && npm run start` |
| Instance Type | **Free** |

Then **Advanced** -> **Health Check Path**: `/api/health`

Leave Root Directory blank on purpose — this is an npm workspaces monorepo, and
the build has to run from the root so `server` and `web` are both installed.

Node 20.18.1 is picked up automatically from [.node-version](.node-version); no
env var needed for it.

### Environment variables

Add these before the first deploy (**Advanced** -> **Add Environment Variable**,
or the Environment tab afterwards):

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the **Internal Database URL** copied in step 2 |
| `JWT_SECRET` | a fresh 64-char hex string (see below) |
| `ENCRYPTION_KEY` | a *different* fresh 64-char hex string |
| `UPLOAD_DIR` | `uploads` |
| `MAX_UPLOAD_BYTES` | `15728640` |

Generate the two secrets locally — never reuse an example from a doc:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Nothing else is required. `APP_URL`, `API_URL` and `GOOGLE_REDIRECT_URI` are
deliberately left unset: [server/src/env.ts](server/src/env.ts) falls back to
`RENDER_EXTERNAL_URL`, which Render injects with the service's real address.

Click **Create Web Service**. The first build takes 4-6 minutes.

## 4. Verify

```bash
curl https://<your-service>.onrender.com/api/health
# {"ok":true,"database":"connected","time":"..."}
```

On free, the first request after an idle period takes **30-60 seconds** — that
is the instance waking up, not a hang.

Then open the site and register — the first account created becomes the
instance admin.

## 5. Wire up Google OAuth

Gmail sending needs an OAuth client pointed at the live callback URL.

1. Google Cloud Console → **APIs & Services** → enable the **Gmail API**
2. **Credentials** → Create OAuth client ID → *Web application*
3. Authorised redirect URI — exactly this, with your real hostname:
   ```
   https://<your-service>.onrender.com/api/mail-accounts/oauth/callback
   ```
4. Put the client ID/secret into the app: **Settings → Google OAuth** (they are
   stored in the database and take effect immediately), or set
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in Render → Environment.

> `GOOGLE_REDIRECT_URI` needs no value on Render. The server derives it from
> `RENDER_EXTERNAL_URL`, which Render injects with the service's real address.

## 6. Stripe (optional — skip to stay on the Free plan)

Set in Render → Environment:

| Variable | Where it comes from |
| --- | --- |
| `STRIPE_SECRET_KEY` | Dashboard → Developers → API keys |
| `STRIPE_PRICE_STARTER` / `_PRO` / `_BUSINESS` | one recurring monthly Price each |
| `STRIPE_WEBHOOK_SECRET` | from the endpoint created below |

Add a webhook endpoint pointing at:
```
https://<your-service>.onrender.com/api/webhooks/stripe
```
Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

---

## How the deploy is wired

| Step | Command | Why |
| --- | --- | --- |
| Build | `npm install --include=dev && npm run db:generate && npm run build` | `--include=dev` is required: `NODE_ENV=production` would make npm skip `typescript`, `vite` and `prisma`, which are all build-time tools here |
| Start | `npm run db:deploy && npm run start` | `prisma db push` runs at **start**, not build — a build container cannot reach the database's private network address |
| Health | `/api/health` | pings Postgres; a 503 fails the deploy rather than shipping a broken instance |

### Schema changes

This project has no `prisma/migrations` directory, so deploys use
`prisma db push`, which syncs `schema.prisma` onto the database. It refuses to
run if a change would drop data — in that case create a real migration
(`npm run db:migrate`) and switch `db:deploy` to `prisma migrate deploy`.

<a name="free-tier-limits"></a>
## Free-tier limits

Three of these change behaviour, not just performance. Plan your testing around
them.

**1. The scheduler does not run on schedule.**
Free instances sleep after ~15 minutes with no HTTP traffic. `node-cron` — which
fires daily campaign sends and all three follow-up levels — is frozen while the
instance sleeps, and a sleeping instance is not woken by the passage of time,
only by an incoming request. So a campaign due at 09:00 goes out whenever
somebody next loads the site.

For testing, either trigger runs manually from the dashboard, or keep the
service awake by pinging `/api/health` every ~10 minutes from an external
uptime service. A free instance kept awake all month uses ~730 of your 750
free instance-hours, so one such service is the most you can do this way.

On wake, [recoverInterruptedRuns()](server/src/services/scheduler.ts) picks up
runs that were mid-flight when the instance went down, so nothing is lost — it
is only delayed.

**2. Attachments are erased.**
No disk can be mounted on free, so `UPLOAD_DIR=uploads` writes to the container
filesystem. Every redeploy, restart and wake-from-sleep wipes it. The database
rows survive, so a campaign will still reference an attachment whose file is
gone and fail at send time. Test attachments in one sitting, or leave them out
of free-tier testing.

**3. The database is deleted after 30 days.**
Render drops free Postgres instances 30 days after creation, with an email
warning first. Upgrade it or export anything you want to keep.

Also: the free Postgres allows 97 connections and the build container has less
RAM, so a build can occasionally OOM where it succeeds locally. Re-running the
deploy usually clears it.

<a name="going-to-production"></a>
## Going to production

Four edits to [render.yaml](render.yaml), then push:

```yaml
databases:
  - plan: basic-256mb              # was: free

services:
  - plan: starter                  # was: free  -> always-on, scheduler works

    disk:                          # add this block: attachments survive deploys
      name: uploads
      mountPath: /var/data
      sizeGB: 1

    envVars:
      - key: UPLOAD_DIR
        value: /var/data/uploads   # was: uploads
```

Roughly $7/mo for the web service plus $7/mo for Postgres. Existing data and
generated secrets are preserved across the plan change, so mailboxes stay
connected.

Migrating attachments is the one thing that does not carry over — files written
before the disk existed are already gone, so re-upload them after the switch.

### Rotating secrets

Never change `ENCRYPTION_KEY` after mailboxes are connected. It encrypts the
stored Gmail refresh tokens (AES-256-GCM); a new key makes every one of them
undecryptable and all connected mailboxes must be re-authorised.

### Custom domain

Add it under Render → Settings → Custom Domains, then set `APP_URL` and
`API_URL` to `https://your-domain.com` (they otherwise default to the
`.onrender.com` address) and add the new callback URL in Google Cloud Console.

---

## Alternative: one-click Blueprint

[render.yaml](render.yaml) describes this exact setup declaratively. Instead of
steps 2 and 3 you can use **New +** -> **Blueprint**, point it at this repo, and
Render creates the database and the web service together, generating
`JWT_SECRET` and `ENCRYPTION_KEY` for you.

A manually created service ignores `render.yaml`, so the file is harmless to
leave in place either way — and it is the reference for what the manual settings
above should be.
