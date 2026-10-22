<p align="center"><img src="readme-banner.png" alt="Windmar Home" width="420"></p>

# Anker Warehouse — Inventory Management System

Serial-level inventory, dispatch, returns (RMA) and activity tracking for the Anker SOLIX stock at the Windmar warehouse in Puerto Rico. Single-page web app with a small serverless backend and a Supabase (Postgres) database.

- **Author:** Sergio A. Romero
- **Version:** `index.html` 3.9 · `inventory.html` 3.9 (Oct 2026)

---

## What it does

| Area | Summary |
|---|---|
| **Dispatch** | Scan, type or paste serials into a queue, add no-serial accessories by quantity, then **Dispatch now** or **Dispatch + Receipt**. Optional case # (e.g. `PPS7202`). |
| **Dispatch + Receipt** | 5-step flow: choose type (Brigada / Regular / Consultor) → upload the DocuSign contract PDF → review → client signs on screen (or skip with a reason) → the PDF is stamped with case #, type, items, notes and signature. Share by WhatsApp, email, a 7-day link (Supabase Storage), or print. |
| **Inventory** | Searchable by serial, model, case # (smart autocomplete). Locations (rack codes such as `NDC3`), add item, bulk import, CSV export. Per-model drill-down shows a live in-stock/dispatched/RMA breakdown (see Changelog, v3.5–v3.6). |
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
logo.png                Windmar Home logo (white, transparent) used in the app header and login screen
readme-banner.png       Logo on a dark background, used only at the top of this README
```

> **Keep the two `auth.js` files in sync.** The repo is set up for both Vercel and Cloudflare Pages, and each host serves its own copy. They have drifted: the Cloudflare copy has no `update_status` AI tool. Any change to auth, AI or dispatch endpoints must be made in both (or one host retired).

> **`inventory.html` is a separate file from `index.html` — confirmed, not hypothetical.** It has its own copy of `NO_SERIAL_SKUS` and its own grouping/drill-down logic. This already drifted once: when the 3 new no-serial SKUs were added to `index.html` in v3.7, `inventory.html` was not updated, so those SKUs briefly rendered on `/inventory` as bogus single-unit serialized rows instead of quantity badges (fixed in v3.7.1). **Any future addition, removal, or SKU-detection change must be made in both files.** Note also: `inventory.html`'s drill-down for regular serialized SKUs still shows the old plain `"N serials"` count with no in-stock/dispatched/RMA breakdown — the v3.5/v3.6 fix on that view was never ported over. Low-impact (view-only page) but listed below under Known gaps.

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
| `SESSION_SECRET` | both `auth.js` | Long random string used to sign login session tokens (generate one, e.g. 64 random characters). **Set it on every host before deploying v3.4.** |
| `RESEND_API_KEY` | `api/check-stock.js` | Low-stock alert emails |

The browser app itself talks to Supabase directly with the project's public (anon) key, which is embedded in `index.html`. **Row Level Security on every table is therefore what actually protects the data** — the in-app Editor lock is a UI gate only.

Cron: `vercel.json` runs `/api/check-stock` daily at 13:00 UTC (`0 13 * * *`). The code comments and email footer say "every 12 hours" — update one or the other.

---

## Sessions and access control (v3.4)

Logging in returns a signed token (valid 12 hours) that the app sends with every protected request. The server verifies it — the user id and role are taken from the token, never from the request body.

| Action | Requirement |
|---|---|
| `login`, `get_users`, `auth` | public |
| `chat` (AI) | valid token with role `admin`/`dispatcher`, **or** the Editor password |
| `save_dispatch` | token, role `admin`/`dispatcher` |
| `sign_dispatch`, `upload_receipt` | any valid token |
| `get_driver_dispatches` | token; own id, or `admin` |
| `change_pin` | token; own account + current PIN |
| `admin_reset_pin` | token with role `admin` + the admin's PIN |

If `SESSION_SECRET` is missing, login still works but protected actions return a clear "SESSION_SECRET is not set" error (they fail closed). Changing `SESSION_SECRET` signs everyone out.

---

## Deploying

1. Push to `main`; Vercel and/or Cloudflare Pages builds from the repo (no build step — static files plus functions).
2. Set the environment variables above on the host.
3. Hard-refresh the app after deploying and confirm the version in the page source header.

There is no service worker in this repo, so a hard refresh is enough to pick up a new `index.html`. If a deploy still "takes longer than usual" to show up, that's most likely Vercel/Cloudflare build or edge-cache propagation time rather than a stale browser copy — give it a minute before troubleshooting further.

---

## Behaviour worth knowing

- **Dispatch is guarded.** Since v3.3 `execDispatch` has a re-entrancy lock, clears the queue before any network call, and only updates rows that are not already `dispatched`. Serials that were already dispatched are skipped and noted in the log instead of being logged twice.
- **The AI tools are guarded the same way:** `dispatch_unit`, `log_return` and `update_status` only change a row if its status is still what was read, and the serial lookup rejects wildcard characters (`% * _ \`).
- **Dispatch + Receipt** performs the inventory dispatch when the PDF is generated (step 5), not when the window opens. The PDF is not stored anywhere unless the **Link** option is used.
- **Manual status corrections bypass the normal dispatch flow.** `execDispatch` explicitly clears `location` when it marks a unit dispatched; a status fixed by hand (e.g. via the AI assistant's `update_status` tool, or directly in Supabase) does not, so a unit can show status `dispatched` while still carrying its last warehouse `location`. This is what the v3.5/v3.6 drill-down fix below surfaces rather than hides.

---

## Known gaps

- The **Assign to** (driver) dropdown is populated at login but its value is never used, and the UI never calls `save_dispatch`, `sign_dispatch` or `upload_receipt`. Driver assignment and the `dispatches` table are not wired up in this version; the driver view's signature button is a placeholder.
- The Cloudflare `auth.js` lacks the `update_status` AI tool.
- Cron schedule and its comments disagree (daily vs. every 12 hours).
- The activity log records no source (UI vs. AI vs. SQL) beyond the message format.
- PINs are stored and compared as plain text, and login attempts are not rate-limited.
- The browser app writes to `inventory`, `activity_log` and the RMA tables directly with the public anon key, so Row Level Security policies on those tables are open to anon reads/writes. Only the server endpoints above are token-protected.
- `inventory.html`'s drill-down for regular (serialized) SKUs still shows the old pre-v3.5 plain `"N serials"` count, with no in-stock/dispatched/RMA breakdown. The v3.5/v3.6 fix in `index.html` was never ported to this file. Not yet fixed — low priority since it's the view-only page, but worth doing if `inventory.html` ever becomes more than a quick reference.
- `index.html` and `inventory.html` also each embed their own copy of the Supabase `SB_URL`/`SB_KEY` constants (a third place, beyond the two `auth.js` files, that needs updating on any credential rotation).

---

## Changelog

**v3.9 (Oct 2026) — both files**
- Anker Prime 12,000mAh Power Bank 130W (`A1335011`): 242 of the 254 units were scanned; the other 12 were skipped by accident during scanning (nothing physically missing — all 254 are in stock). Removed from `NO_SERIAL_SKUS` in both files. The 242 scanned units became normal serialized rows; the remaining 12 got individual placeholder rows (`NO-SN-A1335011-01` through `-12`, status `in-stock`) instead of one combined quantity row, so the SKU total still reads 254 and each pending unit is visible in the drill-down. **When one of those 12 gets re-scanned, just `UPDATE` that row's `serial` to the real value — no re-import needed.**
- With this, all 3 of the Oct 2026 SKU additions (PowerCore, Prime 200W, Prime 130W) are resolved except for the 12 pending Prime 130W serials above. `NO_SERIAL_SKUS` is back down to the original 5 cable/accessory SKUs plus PowerCore (`A1263S12`), which is permanent.

**v3.8 (Oct 2026) — both files**
- Anker Prime 20,000mAh Power Bank 200W (`A1336011`) real serials arrived (269 units). Removed from `NO_SERIAL_SKUS` in both `index.html` and `inventory.html`. Process: SELECT to confirm the placeholder row (quantity 269, no location) → DELETE the placeholder (`NO-SN-A1336011`) → INSERT the 269 real serials as `in-stock` rows → SELECT to confirm 269 rows / 269 in-stock / 0 leftover placeholder → remove the SKU code from both files' arrays. It now behaves as a normal serialized SKU with the usual per-model drill-down and status breakdown.
- Anker Prime 12,000mAh Power Bank 130W (`A1335011`) is still pending — remains in `NO_SERIAL_SKUS` in both files until its real serials are collected, then follows the same process above.
- Anker PowerCore 10,000 (`A1263S12`) is unaffected — stays in `NO_SERIAL_SKUS` permanently (no physical serial exists on these units).

**v3.7.1 (Oct 2026) — `inventory.html` only**
- `inventory.html` has its own independent `NO_SERIAL_SKUS` array (it does not share code with `index.html`). It was missed when the 3 SKUs below were added in v3.7, so on the `/inventory` page they were showing as regular single-unit serialized items instead of quantity-tracked ones. Added `A1263S12`, `A1336011`, `A1335011` to this file's array to match `index.html`. See the callout above "Repository layout" — this is now a confirmed, recurring risk, not a hypothetical one.

**v3.7 (Oct 2026)**
- Added 3 new quantity-tracked (no-serial) SKUs to `NO_SERIAL_SKUS`:
  - **PowerCore 10,000** (`A1263S12`, 1624 units) — ships with no serial number on the box at all, same as the existing no-serial accessories (e.g. the AC Charging Cable, `A17U1111`). This is a **permanent** no-serial SKU.
  - **Anker Prime 20,000mAh Power Bank 200W** (`A1336011`, 269 units) and **Anker Prime 12,000mAh Power Bank 130W** (`A1335011`, 254 units) — these units do have individual serial numbers, just not yet scanned. This is an **interim** state only: once the real serials are collected, pull these two SKU codes back out of `NO_SERIAL_SKUS`, delete their placeholder rows, and bulk-import the real units as normal serialized rows.

**v3.6 (Oct 2026)**
- v3.5 fixed the ambiguous drill-down count but paired a filtered row count against an unfiltered status breakdown (e.g. `101 in-stock · 1 dispatched · 102 total (48 shown with current filter)` when filtering by location — the "48" matched nothing else in that line). Now, whenever a filter (status/search/location/date) is active, the breakdown itself is computed from the filtered rows on screen, so the numbers always add up to what's shown (e.g. `47 in-stock · 1 dispatched · 48 shown (102 total, unfiltered)`). With no filter active, it's still the full-model breakdown as in v3.5.

**v3.5 (Oct 2026)**
- Fixed a misleading per-model drill-down header count in Inventory: it showed a single "N serials" number that silently followed whatever status filter was active, and defaulted to summing **all** statuses (in-stock + dispatched + RMA) together when "All statuses" was selected — e.g. a model with 101 in-stock and 1 already-dispatched unit showed "102 serials" with no indication one was already out. The header now always shows an explicit in-stock/dispatched/RMA breakdown, so the number people actually plan stock around is never hidden inside a combined total.

**v3.4 (Oct 2026)**
- Signed session tokens: the AI assistant, driver view, PIN change/reset and dispatch/receipt endpoints now verify who is calling on the server. New `SESSION_SECRET` environment variable required.
- Receipt upload file names are validated.

**v3.3 (Oct 2026)**
- Windmar Home logo added to the app header and login screen.
- Fixed duplicate dispatches/log entries (lock, queue cleared early, guarded update, skip-and-note for already-dispatched serials).
- Receipt share actions now use the case # captured when the PDF was generated (previously file names fell back to `recibo`).
- AI endpoints: guarded writes in `dispatch_unit`, `log_return` and `update_status`; `log_return` refuses no-op returns; serial lookup rejects wildcards.

**v3.2 (Sep 2026)**
- Smart search/autocomplete in dispatch and inventory fields.
- Activity log date-range and event-type filter with printable report.
- Case lookup summary card (units, dispatch/RMA counts, first/last activity, timeline).
