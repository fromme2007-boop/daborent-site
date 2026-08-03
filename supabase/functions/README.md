# DaboRent edge functions — WhatsApp reminder recovery (post-Razorpay)

> These sources are mirrors of functions deployed to Supabase project
> `afecjfhevnvkpascmbiq` (**tenant-management**). They were only ever edited in
> the Supabase dashboard and had **no version control anywhere** — that is why
> they are checked in here. They belong in the app repo; move them when it is
> convenient.
>
> **Nothing in this directory has been deployed.** The live functions are still
> the broken Razorpay versions.

## What broke

Razorpay was permanently closed on **23 July 2026**. `send-scheduled-whatsapp-reminders`
minted a Razorpay payment link per charge via `ensurePaymentLink()`. That call now
throws — and it sat in the per-charge loop **with no try/catch**, so the first
failing charge aborted the entire run before any log row was written.

Confirmed in the data: the last `whatsapp_message_logs` row is
`2026-07-23 05:00:07Z`, and there are **zero rows since** — not even failures.
Three crons (jobids 3, 4, 7 — 03:30, 04:00, 05:00 UTC) have been firing into a
dead function every day and failing silently.

## The hard blocker

Template `tenant_payment_due_v1` has a Meta-approved URL button hardcoded to
`https://rzp.io/rzp/`, and its button parameter is **mandatory**. There is no
code-only fix — a new template is required.

Verified against the Graph API on 29 July 2026: WABA `1336192051737341`
("Cordelia Barreto", APPROVED) contains only `meter_alert`,
`tenant_payment_due_v1` and `hello_world`. **`tenant_payment_due_v2` has never
been submitted.** Submitting it is the critical path.

## Changes in this directory

### `create-payment-template-v2/` (new)
Submits `tenant_payment_due_v2` (Utility / English / **no buttons** / 6 body
params) and can poll its review status. Gated behind `x-cron-secret` so the URL
alone cannot create templates on the business account. Delete once approved.

### `send-scheduled-whatsapp-reminders/`
- Razorpay removed entirely (link creation, `charge_payments` insert, gateway
  columns, `RAZORPAY_*` env reads).
- **Per-charge `try/catch`** — one bad charge can no longer kill the whole run.
  This is the fix that actually prevents a repeat of the silent 6-day outage.
- Switched to `tenant_payment_due_v2`; button component dropped, `{{6}}` = UPI VPA.
- Dedup no longer filters on `template_name`, so the v1 → v2 switch cannot
  double-remind a tenant for the same charge on the same day.
- Dropped the "partial payment is not supported" skip. That rule existed only
  because Razorpay links were fixed-amount; the message now just states the
  outstanding figure. **Behaviour change:** partially-paid charges now get
  reminded for the remaining balance.
- `dry_run: true` renders and returns exactly what would be sent, contacts
  nobody, and writes **no** log rows (so it can't block the real send).
- Fixed preview text that read "for Room Room 7" — `room_number` already carries
  its prefix in this database (`Room 7`, `ROOM 11`), and `{{2}}` is the full
  room text, so it is passed through as-is.

### `send-manual-whatsapp-reminder/`
Was broken differently and more dangerously: it omitted the button component
when `payment_url` was null (Meta rejects — v1's button is mandatory), and for
older charges it still sent a **dead `rzp.io` link**. Now on v2, no buttons.
Also now includes `late_fee` in the outstanding amount, matching the scheduled
function.

## Deploy

Deploy is **not** done. Order matters — the template must be APPROVED first,
or every send fails with `(#132001) Template name does not exist`.

1. Submit the template, then poll until `status: APPROVED`:
   ```
   POST /functions/v1/create-payment-template-v2      (x-cron-secret header)
   GET  /functions/v1/create-payment-template-v2?action=check
   ```
2. Deploy `send-scheduled-whatsapp-reminders` (`verify_jwt: false`) and
   `send-manual-whatsapp-reminder` (`verify_jwt: true`).
3. Dry-run against real data without messaging anyone:
   ```json
   { "reminder_type": "due_tomorrow", "target_date": "2026-08-09", "dry_run": true }
   ```
4. Live-test on the isolated TEST charge only (`TEST ROOM`, phone 9373620540,
   ₹1 water charge due 2026-08-01) before the 8 August run.

## Config

| Setting | Value |
|---|---|
| UPI VPA (`{{6}}`) | `cordeliabbarreto-1@oksbi` (env `UPI_VPA`) |
| Template | `tenant_payment_due_v2` (env `WHATSAPP_TEMPLATE_NAME`) |
| Language | `en` — **not** `en_US`, which returns `(#132001)` |
| WABA | `1336192051737341` |

Every value is env-overridable, so a template re-submission under a different
name needs a config change, not a redeploy.

## Decentro integration (scaffold — 30 July 2026)

Post-call with Decentro (Bhavana): PAYG 1% model chosen, T+1 settlement,
sandbox promised, use-case eligibility review pending. NPCI risk policy
blocks UPI intent links to personal VPAs (verified 30 Jul on PhonePe and
Paytm with A/B tests), so one-tap in-app payment requires a merchant-class
virtual account — which is what Decentro provides.

### `create-decentro-payment-link/` (new, NOT deployed)
Tenant-authenticated. Computes the charge's outstanding (late fee included),
creates a Collections v3 payment link/intent, stores a `charge_payments` row
(`provider: decentro`, `status: created`), reuses unexpired same-amount links.

### `decentro-webhook/` (new, NOT deployed)
Secret-gated callback receiver. Stores every raw payload in
`payment_gateway_events` first, then matches `reference_id` →
`charge_payments`, marks paid with payer VPA + UTR, and rolls the amount into
`charges.amount_paid`/`status` — same settlement shape the Razorpay webhook had.

### Before deploy
1. Link creation is **VERIFIED against live staging** (30 Jul 2026,
   decentro_txn_id `A884FD698ED246AE870ABEB396B3522E`): base URL
   `staging.api.decentro.tech`, auth = `client_id`+`client_secret` headers
   only, `expiry_time` ≤ 1440, link in `data.upi_uris.common_uri`, payment
   page on `decpay.in`. The **webhook payload shape is still unverified** —
   confirm with one staging callback; parsing is isolated in `parseCallback`.
2. Set edge-function secrets: `DECENTRO_BASE_URL`
   (`https://staging.api.decentro.tech` first), `DECENTRO_CLIENT_ID`,
   `DECENTRO_CLIENT_SECRET`, `DECENTRO_CONSUMER_URN`,
   `DECENTRO_WEBHOOK_SECRET` (self-chosen; also configure it on the callback
   registration in Decentro's dashboard). No module secret — the PA stack
   authenticates with client id + client secret only.
3. Both functions are **DEPLOYED (v1, 30 Jul 2026)**:
   `create-decentro-payment-link` (`verify_jwt: true`), `decentro-webhook`
   (`verify_jwt: false`). The deployed builds carry temporary staging-only
   env fallbacks (not in this repo — it is public); once dashboard secrets
   are set, redeploy from these sources to drop them.
4. End-to-end settlement **verified 30 Jul** against the deployed webhook:
   simulated SUCCESS callback → payment row paid (UTR + payer VPA captured)
   → charge rolled to paid. Test data reset afterwards. Still pending: one
   REAL staging callback to confirm Decentro's actual payload field names.

## Known gap

The outage was invisible for six days because nothing watches these crons. The
function now returns per-charge `failed` counts instead of a blanket 500, but
**nobody reads the response.** A cron that alerts when a reminder run sends 0
messages on a day with due charges is still missing.
