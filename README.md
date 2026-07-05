# QueueForge

A distributed job scheduler built with Node.js, Express, and SQLite, with AI-generated
failure summaries (via Gemini) for jobs that exhaust their retries.

## Architecture Notes

- **Atomic claiming:** the worker's poll loop wraps a `SELECT` + `UPDATE ... WHERE status='QUEUED'`
  in a `BEGIN IMMEDIATE TRANSACTION`. The `WHERE status='QUEUED'` guard is what actually
  prevents double-claiming — if two workers race, only one UPDATE affects a row (changes=1),
  the other gets changes=0 and skips it.
- **Retry strategies:** FIXED, LINEAR, EXPONENTIAL backoff, configured per queue via a
  `retry_policies` row.
- **DLQ + AI summary:** once `retry_count` exceeds the policy's `max_retries`, the job is
  marked FAILED, inserted into `dead_letter_queue`, and its logs are sent to Gemini
  (`gemini-1.5-flash`) for a plain-English root-cause summary.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set a real `JWT_SECRET` and `GEMINI_API_KEY`. If you don't have a Gemini
key yet, the app still runs — `aiService.js` returns a placeholder string instead of crashing.

## Run

Run the API and the worker in two separate terminals:

```bash
npm start     # API server on :3000
npm run worker # Job worker (poll + execute + heartbeat)
```

You can run multiple `npm run worker` instances in parallel to test the atomic-claim logic.

## Testing the flow

**1. Sign up**
```
POST /api/auth/signup
{ "email": "admin@forge.io", "password": "securepassword123" }
```
Save the `token` from the response.

**2. Auth header on everything else**
```
Authorization: Bearer <token>
```

**3. Create a project**
```
POST /api/projects
{ "name": "E-Commerce Pipeline" }
```

**4. Create a queue with a fast retry policy (for demo speed)**
```
POST /api/queues
{
  "name": "payment-processing",
  "project_id": 1,
  "strategy": "EXPONENTIAL",
  "max_retries": 2,
  "base_delay_seconds": 3
}
```

**5. Submit a job that intentionally fails (to see retries + DLQ + AI summary)**
```
POST /api/jobs
{
  "queue_id": 1,
  "type": "IMMEDIATE",
  "payload": "{\"shouldFail\": true, \"failMessage\": \"Payment gateway timeout - Error Code 504\"}"
}
```

Watch the worker terminal — it will retry twice with exponential backoff, then route the
job into `dead_letter_queue` with an AI-generated summary attached.

**6. Check dashboard stats**
```
GET /api/dashboard/stats
```

## Known limitations (worth noting in your design-decisions doc)

- SQLite's file-based storage means a single-writer bottleneck under heavy concurrent
  write load — fine for a demo/assignment, but Postgres with `SELECT ... FOR UPDATE SKIP LOCKED`
  would scale claiming better across many worker processes.
- On Render/Railway free tiers, SQLite's file resets on redeploy since the filesystem is
  ephemeral — call this out explicitly as a production tradeoff.
- Cron sync polls every 30s rather than reacting instantly to new SCHEDULED jobs — acceptable
  for the assignment scope, but worth flagging as a design decision.
