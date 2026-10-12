# Anker Warehouse — Inventory Management System

Serial-level inventory, dispatch, returns (RMA) and activity tracking for the Anker SOLIX stock at the Windmar warehouse in Puerto Rico. Single-page web app with a small serverless backend and a Supabase (Postgres) database.

- **Author:** Sergio A. Romero
- **Version:** 3.3 (Oct 2026)

---

## What it does

| Area | Summary |
|---|---|
| **Dispatch** | Scan, type or paste serials into a queue, add no-serial accessories by quantity, then **Dispatch now** or **Dispatch + Receipt**. Optional case # (e.g. `PPS7202`). |
| **Dispatch + Receipt** | 5-step flow: choose type (Brigada / Regular / Consultor) → upload the DocuSign contract PDF → review → client signs on screen (or skip with a reason) → the PDF is stamped with case #, type, items, notes and signature. Share by WhatsApp, email, a 7-day link (Supabase Storage), or print. |
| **Inventory** | Searchable by serial, model, case # (smart autocomplete). Locations (rack codes such as `NDC3`), add item, bulk import, CSV export. |
| **RMA / Returns** | Log single or bulk returns. Reasons that restock (`No cambio`, `Re coordinado`, `Cancelado`, `Back to stock`) return the unit to stock; others keep it flagged RMA. Incoming damaged units and outbound shipments are tracked. |
| **Activity log** | Every dispatch, return, add and correction, with a date-range and type filter and a printable report. |
| **AI assistant** | Admin-only chat panel backed by Claude (Haiku 4.5) with tool use: query inventory/log, dispatch a unit, log a return, correct a status, update a location. |
| **Low-stock alert** | Scheduled job that emails a Spanish-language alert when a model has had 25+ units and 20 or fewer are in stock. |

---

## Repository layout

```
index.html              Main app (single file: HTML + CSS + JS)
inventory.html          Read-only inventory page, served at /inventory
api/auth.js             Vercel serverless function: login, PINs, AI chat, receipts
api/check-stock.js      Vercel cron endpoint: low-stock email via Resend
functions/api/auth.js   Cloudflare Pages Function: Cloudflare equivalent of api/auth.js
vercel.json             /inventory rewrite and the cron schedule
```

> **Keep the two `auth.js` files in sync.** The repo is set up for both Vercel and Cloudflare Pages, and each host serves its own copy. They have drifted: the Cloudflare copy has no `update_status` AI tool. Any change to auth, AI or dispatch endpoints must be made in both (or one host retired).

---

## Data model (Supabase)

Tables used: `inventory`, `activity_log`, `dispatches`, `users`, `rma_incoming`, `rma_shipments`.

**`inventory`** — `id` (uuid), `serial`, `sku` (product name), `sku_code`, `status`, `ref`, `notes`, `updated_at`, `location`, `quantity`.

- `status` is one of **`in-stock`**, **`dispatched`**, **`rma`** (note the hyphen in `in-stock`).
- Accessories without serials are rows where `quantity` is tracked instead of status.

**`activity_log`** — `id`, `ts`, `type` (`dispatch`, `rma`, `add`, `correction`), `msg`, `serial`, `reason`, `notes`.

- Rows written by the UI have an empty `serial` and a message like `Dispatched N item(s) [case]: ...`.
- Rows written by the AI have `serial` set and messages like `Dispatched via AI: ...` or `[CORRECTION] ...`.

**`dispatches`** — driver-assignment/receipt records (`case_ref`, `dispatch_type`, `serials` jsonb, `assigned_to`, `status`, PDF URLs, ...). The `/api/auth` actions for it exist, but the current UI does **not** write to this table (see Known gaps).

Storage bucket: `almacen-recibos` (receipt PDFs, shared via 7-day signed URLs).

---

## Configuration

Environment variables (set in the Vercel and/or Cloudflare dashboard — never commit values):

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_KEY` | `api/auth.js`, `api/check-stock.js`, `functions/api/auth.js` | Supabase key for server-side calls |
| `EDIT_PASSWORD` | both `auth.js` | Password that unlocks editing in the UI |
| `ANTHROPIC_API_KEY` | both `auth.js` | AI assistant |
| `RESEND_API_KEY` | `api/check-stock.js` | Low-stock alert emails |

The browser app itself talks to Supabase directly with the project's public (anon) key, which is embedded in `index.html`. **Row Level Security on every table is therefore what actually protects the data** — the in-app Editor lock is a UI gate only.

Cron: `vercel.json` runs `/api/check-stock` daily at 13:00 UTC (`0 13 * * *`). The code comments and email footer say "every 12 hours" — update one or the other.

---

## Deploying

1. Push to `main`; Vercel and/or Cloudflare Pages builds from the repo (no build step — static files plus functions).
2. Set the environment variables above on the host.
3. Hard-refresh the app after deploying and confirm the version in the page source header.

There is no service worker in this repo, so a hard refresh is enough to pick up a new `index.html`.

---

## Behaviour worth knowing

- **Dispatch is guarded.** Since v3.3 `execDispatch` has a re-entrancy lock, clears the queue before any network call, and only updates rows that are not already `dispatched`. Serials that were already dispatched are skipped and noted in the log instead of being logged twice.
- **The AI tools are guarded the same way:** `dispatch_unit`, `log_return` and `update_status` only change a row if its status is still what was read, and the serial lookup rejects wildcard characters (`% * _ \`).
- **Dispatch + Receipt** performs the inventory dispatch when the PDF is generated (step 5), not when the window opens. The PDF is not stored anywhere unless the **Link** option is used.

---

## Known gaps

- The **Assign to** (driver) dropdown is populated at login but its value is never used, and the UI never calls `save_dispatch`, `sign_dispatch` or `upload_receipt`. Driver assignment and the `dispatches` table are not wired up in this version; the driver view's signature button is a placeholder.
- The Cloudflare `auth.js` lacks the `update_status` AI tool.
- Cron schedule and its comments disagree (daily vs. every 12 hours).
- The activity log records no source (UI vs. AI vs. SQL) beyond the message format.

---

## Changelog

**v3.3 (Oct 2026)**
- Fixed duplicate dispatches/log entries (lock, queue cleared early, guarded update, skip-and-note for already-dispatched serials).
- Receipt share actions now use the case # captured when the PDF was generated (previously file names fell back to `recibo`).
- AI endpoints: guarded writes in `dispatch_unit`, `log_return` and `update_status`; `log_return` refuses no-op returns; serial lookup rejects wildcards.

**v3.2 (Sep 2026)**
- Smart search/autocomplete in dispatch and inventory fields.
- Activity log date-range and event-type filter with printable report.
- Case lookup summary card (units, dispatch/RMA counts, first/last activity, timeline).
