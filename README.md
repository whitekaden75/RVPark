# RV Park Reservation App

React + Node.js app for managing RV park registrations with:

- RV site browsing
- riverfront and site-size visibility
- customer creation
- reservation creation
- multi-site stays within one reservation
- availability search
- automatic site-switch planning
- overlap prevention at the database layer

## Project Layout

- `client/` React app built with Vite
- `server/` Express API with PostgreSQL
- `sql/001_rv_park_schema.sql` copy/paste SQL for your Railway Postgres database
- `sql/002_seed_rv_sites_example.sql` optional starter site data you can edit first
- `sql/003_pricing_and_site_categories_upgrade.sql` site-category and pricing upgrade
- `sql/004_add_amount_paid_to_reservations.sql` tracks payments against a reservation
- `sql/005_make_customer_contact_fields_optional.sql` allows email or phone to be blank
- `sql/006_add_missing_reservation_notes_column.sql` adds the reservation notes field if your live table is missing it
- `sql/007_add_rig_size_to_reservations.sql` stores the guest RV length in feet
- `sql/008_add_reservation_cancellation_and_history.sql` adds reservation status and canceled-booking history support
- `sql/009_add_reservation_billing_fields.sql` adds manual total and monthly billing fields
- `sql/010_add_yearly_reservation_term.sql` adds yearly reservation support
- `sql/011_add_stripe_payment_records.sql` tracks Stripe checkout sessions so paid balances can be recorded safely
- `sql/012_update_stripe_payment_records_for_pending_links.sql` updates the Stripe payment table if you already ran the earlier Stripe SQL before link/pending support
- `sql/013_add_motorhome_type_flags.sql` adds the class A, class C, and with-tow motor home flags to reservations
- `sql/014_add_stripe_webhook_tracking.sql` adds Stripe webhook event storage and richer payment-status fields
- `sql/2026-08-01_add_public_booking_checkouts.sql` stores short-lived public booking details until Stripe confirms a card or ACH bank deposit
- `sql/2026-08-15_add_reservation_price_choices.sql` stores each booking's requested discounts and selected payment method
- `sql/2026-08-24_add_reservation_check_ins.sql` stores signed iPad check-in forms and arrival timestamps
- `add-stay-level-check-ins.sql` allows a separate signed check-in for each return visit on one reservation

## Database Setup

Run the SQL in [sql/001_rv_park_schema.sql](/Users/kadenwhite/Desktop/RVPark/sql/001_rv_park_schema.sql).

It creates:

- `rv_sites`
- `customers`
- `reservations`
- `reservation_site_stays`
- an exclusion constraint that prevents overlapping bookings for the same site

If you want starter site records, edit and run [sql/002_seed_rv_sites_example.sql](/Users/kadenwhite/Desktop/RVPark/sql/002_seed_rv_sites_example.sql) after the schema file.

If your database is moving to the expanded pricing model, run [sql/003_pricing_and_site_categories_upgrade.sql](/Users/kadenwhite/Desktop/RVPark/sql/003_pricing_and_site_categories_upgrade.sql) too.

If you want to track payments and remaining balance, run [sql/004_add_amount_paid_to_reservations.sql](/Users/kadenwhite/Desktop/RVPark/sql/004_add_amount_paid_to_reservations.sql) too.

If you want customers to be allowed with only an email or only a phone number, run [sql/005_make_customer_contact_fields_optional.sql](/Users/kadenwhite/Desktop/RVPark/sql/005_make_customer_contact_fields_optional.sql) too.

If your live `reservations` table is missing the `notes` column, run [sql/006_add_missing_reservation_notes_column.sql](/Users/kadenwhite/Desktop/RVPark/sql/006_add_missing_reservation_notes_column.sql) too.

If you want to track how big each guest rig is, run [sql/007_add_rig_size_to_reservations.sql](/Users/kadenwhite/Desktop/RVPark/sql/007_add_rig_size_to_reservations.sql) too.

If you want canceled reservations to stay in history without blocking sites, run [sql/008_add_reservation_cancellation_and_history.sql](/Users/kadenwhite/Desktop/RVPark/sql/008_add_reservation_cancellation_and_history.sql) too.

If you want manual totals and monthly billing fields for long-term stays, run [sql/009_add_reservation_billing_fields.sql](/Users/kadenwhite/Desktop/RVPark/sql/009_add_reservation_billing_fields.sql) too.

If you want yearly bookings that stay open-ended until canceled, run [sql/010_add_yearly_reservation_term.sql](/Users/kadenwhite/Desktop/RVPark/sql/010_add_yearly_reservation_term.sql) too.

If you want Stripe payments recorded back onto reservations, run [sql/011_add_stripe_payment_records.sql](/Users/kadenwhite/Desktop/RVPark/sql/011_add_stripe_payment_records.sql) too.

If you already ran the earlier Stripe payment SQL and need the newer pending-link columns, run [sql/012_update_stripe_payment_records_for_pending_links.sql](/Users/kadenwhite/Desktop/RVPark/sql/012_update_stripe_payment_records_for_pending_links.sql) too.

If you want to track motor home class and tow details on reservations, run [sql/013_add_motorhome_type_flags.sql](/Users/kadenwhite/Desktop/RVPark/sql/013_add_motorhome_type_flags.sql) too.

If you want Stripe webhook receipts and richer payment-status tracking, run [sql/014_add_stripe_webhook_tracking.sql](/Users/kadenwhite/Desktop/RVPark/sql/014_add_stripe_webhook_tracking.sql) too.

Before enabling payment-first public booking, run [sql/2026-08-01_add_public_booking_checkouts.sql](/Users/kadenwhite/Desktop/RVPark/sql/2026-08-01_add_public_booking_checkouts.sql). This table stores a short Stripe Checkout site hold and the guest-entered booking details; the actual reservation is inserted only after Stripe reports the deposit as paid. A submitted ACH payment keeps the site held while the bank payment processes.

Run [sql/2026-08-15_add_reservation_price_choices.sql](/Users/kadenwhite/Desktop/RVPark/sql/2026-08-15_add_reservation_price_choices.sql) so both client and admin bookings retain the requested discounts and selected payment method.

Run [sql/2026-08-24_add_reservation_check_ins.sql](/Users/kadenwhite/Desktop/RVPark/sql/2026-08-24_add_reservation_check_ins.sql) before deploying the **Check In** admin page. It stores the guest count, RV details, accepted rules version, signature image, and check-in timestamp with the reservation.

Run [add-stay-level-check-ins.sql](/Users/kadenwhite/Desktop/RVPark/add-stay-level-check-ins.sql) before deploying the return-visit check-in update. It assigns existing check-ins to their reservation’s earliest stay and changes check-in uniqueness from the whole reservation to each individual site-stay segment.

### Nightly payment progress

Standard reservations derive payment amounts from nightly prices and payment history instead of displaying a running dollar balance throughout the site. Online bookings retain their checkout quote, including the guest's selected regular or discounted price and per-night card price, for the originally booked dates/site. Check-in, confirmation emails, the schedule, and payment links use that same quote rather than today's rate table. Older online bookings recover the quote from their saved checkout totals. Ordinary contact, check-in, and payment-method edits do not change it; intentional discount, pricing-category, or dates/site changes can reprice the stay. This uses the existing `public_booking_checkouts.booking_payload` and requires no new SQL migration.

For completed online checkouts, date moves and site moves within the original pricing category preserve the original prices of already-purchased nights. Moving nights to a different category (for example, off river to river) uses that category's current prices and credits the payments already collected. Staff can send the entered payment amount to Stripe Terminal even when it exceeds the calculated balance or the calculated balance is zero, so site upgrades and adjustments are not blocked by the balance calculation. Added unpaid nights use the applicable current rates, including consecutive site moves and the free seventh night. The checkout must prove the original payment covered its quoted stay, and the booking must still show at least that much collected; partial/unpaid checkouts do not create paid-night credit. Older checkouts use the original site's category when no saved category quote exists. Explicit discount or pricing-category changes continue to use the chosen pricing. Payment events are allocated oldest first so later cash/card payments at a new site rate cannot reprice an earlier paid night. Covering the cash total alone does not clear an outstanding card-priced balance.

Office-created standard reservations without an online checkout quote continue using the configured nightly rates. The UI reports paid stay nights and nights left to pay, then hides that progress once every stay night is covered. Exact dollar amounts remain available only inside payment collection screens.

Every seventh consecutive night is free: six paid nights earn the seventh night free. The consecutive-night count continues when a guest switches sites without a date gap and resets when there is a gap. Manual-total, monthly, and yearly billing keep their separate billing behavior. This calculation uses the existing payment-event history and does not require another SQL migration.

### Saved payment methods for reservations and monthly guests

Before deploying this feature, run `sql/2026-10-24_saved_payment_methods.sql` against the existing database, then deploy both the server and client. The migration makes payment-method storage optional, creates consent and charge audit tables, and imports previously saved online payment methods only when their original consent timestamp exists. It can be rerun without restoring removed methods. `GUEST_AUTH_SECRET`, Stripe keys, and the existing `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `payment_intent.succeeded`, and `payment_intent.payment_failed` webhook events are required.

Online booking, the after-hours card flow, and guest payment links have a separate **Save my payment method for later** checkbox. It starts unchecked, and guests can pay without saving a method. Stripe stores the sensitive details; the app retains Stripe references, masked details, and the consent text/version/timestamp.

In a reservation’s **Manage payments** area or on a guest’s **Monthly** card, expand **Saved payment methods**. **Create secure card-save link** lets a guest authorize and add a card through Stripe without paying anything. Copy the link or open it for the guest, then use **Refresh saved methods** after setup. Links expire after seven days. Saved methods are available across reservations belonging to that same customer record and can be removed in the same panel.

To collect a later payment, choose the method, enter the exact agreed amount and description, record how the guest separately approved that charge, and check the approval box. Monthly rent and utilities use this same flow; saving a method does not enroll the guest in automatic monthly billing. Failed or authentication-required attempts collect no money and direct staff to send a guest payment link. Processing bank payments are credited only when Stripe confirms success. Lost responses can be retried using the same request without creating another charge. The saved-method feature has automated tests with mocked Stripe responses; complete a Stripe test-mode setup/payment/webhook check before enabling it in production.

### Office booking tools and morning cash verification

Run these migrations against the existing database before deploying these tools: `sql/2026-10-10_reservation_balance_waivers.sql`, `sql/2026-10-10_monthly_and_combined_bookings.sql`, and `sql/2026-10-10_after_hours_cash_verification.sql`. They can be rerun safely and do not run automatically at startup.

Open a reservation to see its single **Manage payments** center. Card collection, cash/check recording, payment links, payment history, and pricing corrections are available together without switching payment views. Enter any positive amount in **Amount to send to terminal**, including amounts above the calculated balance or on a fully paid booking; optional nightly presets only fill the editable amount. Terminal payments are linked to the selected reservation and appear in its payment history after Stripe confirms success. Open **Adjust pricing or paid amount** and use **Waive remaining balance** to settle the current booking without recording money that was never collected. An optional office note and a separate audit record preserve the reason. **Restore balance** reverses the waiver. Changing the dates, site, or explicit pricing ends the waiver; contact edits and payment updates preserve it.

Open **Edit dates/site** to find **Monthly & combined bookings**. Save pending date or site changes before using these controls. **Mark as monthly** includes shorter stays in the Monthly page without changing their price. Combine consecutive, active bookings for the same guest after reviewing the site/date sequence. The default **Use monthly rent pricing — no whole-trip total** combines them into monthly billing without setting a price. Set the rent, billing day and electricity details later on the Monthly page. Uncheck that option when combining bookings with an agreed whole-trip total. The combined booking retains existing stay IDs, collected payments, check-ins and associated records. The old booking is archived and its detail link opens the combined booking. Finish pending payments and verify after-hours cash before combining. Existing monthly billing settings are retained when combining into a monthly account; review recurring charges and any previous waiver after combining. Closing a reservation card leaves the originating admin page and its filters in place.

**Overview → After-hours cash to verify** shows QR cash bookings awaiting a morning envelope check, including older bookings that were approved before cash was verified. Count the envelope, adjust **Cash counted** if needed, and click **Received cash**. This records the actual cash in the payment history, approves the booking, and saves an office receipt with a timestamp and administrator ID. The accepted QR quote is retained even if rate tables have changed. A short envelope leaves its remaining balance in Payment follow-up. Repeated or concurrent verification clicks cannot credit cash twice. If money was already recorded, **Verify recorded cash** verifies matching cash payment history without adding another payment; review the booking if that history does not match the envelope.

### Stripe Terminal

Register the Stripe S710 to the live Stripe account and keep it assigned to the correct Terminal Location. The admin reservation flow uses Stripe's server-driven Terminal integration: after a reservation is created, the office can record cash/check or send the card deposit to the reader, and the reservation is updated only after Stripe confirms a successful card-present PaymentIntent.

If the Stripe account has exactly one physical Terminal reader, the server discovers it automatically. If the account has multiple readers, set `STRIPE_TERMINAL_READER_ID` to the office reader ID (it begins with `tmr_`). Office Terminal buttons always use the card price. Bank-account/ACH payment remains available only through secure guest payment links; cash and check are recorded separately in the office.

For safe local testing, create a Terminal location in the Stripe sandbox, then register a simulated reader through Stripe's API using the registration code `simulated-s710`. Use the resulting sandbox `tmr_` ID with a test secret key:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_TERMINAL_READER_ID=tmr_your_simulated_reader
STRIPE_TERMINAL_SIMULATOR_ENABLED=true
STRIPE_MOTO_ENABLED=false
```

With simulator mode enabled, the server automatically presents Stripe's default test card after sending each server-driven Terminal payment. The admin page identifies the reader as a test simulator, and no real card is charged. Never enable simulator mode with a live secret key; the server rejects that configuration. Set `STRIPE_TERMINAL_SIMULATOR_ENABLED=false` and use the physical reader's live `tmr_` ID in production.

Phone orders use Stripe Terminal MOTO and are disabled by default. Ask Stripe Support to approve MOTO for the account before setting `STRIPE_MOTO_ENABLED=true`. Prefer a secure guest payment link whenever the caller can open one; manually entered MOTO payments have higher fraud and dispute risk.

Enable both Cards and ACH Direct Debit (`us_bank_account`) in the Stripe Dashboard. The webhook endpoint must receive `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.payment_failed`, and `charge.refunded` events. The PaymentIntent events provide the server-side backup that records successful Stripe Terminal payments on the matching reservation even if the check-in browser closes or misses the reader response. ACH payments can remain processing after the guest returns to the site, so the reservation is created only after `checkout.session.async_payment_succeeded`.

## Local Setup

### 1. Backend

Create `server/.env` from [server/.env.example](/Users/kadenwhite/Desktop/RVPark/server/.env.example).

Required values:

- `DATABASE_URL`
- `PORT`
- `CLIENT_ORIGIN`
- `PUBLIC_APP_URL` (the public HTTPS frontend URL used in guest-facing payment links; never use localhost)
- `ADMIN_SESSION_SECRET`
- `AFTER_HOURS_ACCESS_TOKEN` (secret value used in the QR-only drive-up URL)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_TERMINAL_READER_ID` (optional when the account has exactly one physical reader)
- `STRIPE_TERMINAL_SIMULATOR_ENABLED` (`true` only for a sandbox simulated reader)
- `STRIPE_MOTO_ENABLED` (`true` only after Stripe approves MOTO on the account)
- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`
- `SENDGRID_FROM_NAME`
- `SENDGRID_REPLY_TO`
- `GUEST_AUTH_SECRET`

Install and run yourself:

```bash
cd server
npm install
npm run dev
```

### SendGrid email setup

Create one SendGrid Restricted Access API key with only `Mail Send` set to Full Access. Add it to the backend environment as `SENDGRID_API_KEY`; never add it to the client or use a `VITE_` prefix.

- `SENDGRID_API_KEY`: the secret SendGrid API key, beginning with `SG.`
- `SENDGRID_FROM_EMAIL`: the verified address guests see as the sender
- `SENDGRID_FROM_NAME`: the display name, such as `Riverpark RV Resort`
- `SENDGRID_REPLY_TO`: a real inbox where guest replies should be delivered
- `GUEST_AUTH_SECRET`: a long random server-only secret used to sign guest email sessions; generate one with `openssl rand -hex 32`

### Mobile online-booking notifications

Run [sql/2026-08-13_add_admin_push_subscriptions.sql](/Users/kadenwhite/Desktop/RVPark/sql/2026-08-13_add_admin_push_subscriptions.sql) in Railway Postgres. Generate one VAPID key pair from the `server` directory with `npx web-push generate-vapid-keys`, then add these backend variables:

- `VAPID_PUBLIC_KEY`: the generated public key
- `VAPID_PRIVATE_KEY`: the generated private key; keep it server-only
- `VAPID_SUBJECT`: a contact URI such as `mailto:reservations@yourdomain.com`

Redeploy both services, sign in to Admin on each phone, and press **Enable booking alerts** once. On iPhone, first open the site in Safari and use **Share → Add to Home Screen**; web push requires iOS/iPadOS 16.4 or newer and the installed Home Screen app. These alerts are sent only after a paid public Stripe checkout creates a reservation. Reservations entered manually in Admin do not send an alert.

The From address must use a SendGrid-verified Single Sender or an authenticated domain. After changing these backend variables, redeploy the server.

### QR-only after-hours drive-up page

Set `AFTER_HOURS_ACCESS_TOKEN` on the backend to a long, random value. The only URL for the drive-up page is:

```text
https://www.RiverparkRVResort.com/?after_hours=YOUR_AFTER_HOURS_ACCESS_TOKEN
```

Use that complete URL as the QR-code destination. The normal website does not link to this page, and both after-hours API endpoints verify the same server-side token. Treat the QR URL like a private link; changing `AFTER_HOURS_ACCESS_TOKEN` immediately invalidates the old QR code.

The page only creates reservations beginning on the current Pacific-Time date. It shows live site availability, displays every site length as the stored length minus three feet, supports the existing secure card-deposit checkout, and adds a cash-envelope option. Cash-envelope reservations remain pending with no payment recorded until the office verifies the envelope and records the cash from Admin.

### 2. Frontend

Create `client/.env` from [client/.env.example](/Users/kadenwhite/Desktop/RVPark/client/.env.example).

Required value:

- `VITE_API_BASE_URL`

Install and run yourself:

```bash
cd client
npm install
npm run dev
```

## Railway Deployment Walkthrough

Your Postgres already lives on Railway, so the main task is connecting a backend service to that existing database and then pointing the React frontend at the deployed API.

### Backend service on Railway

1. Push this project to GitHub.
2. In Railway, create a new project.
3. Add a new service from GitHub and point it at this repo.
4. Set the backend service root directory to `server`.
5. In the backend service variables, add:
   - `DATABASE_URL`
   - `CLIENT_ORIGIN`
   - `PORT`
   - `ADMIN_SESSION_SECRET`
   - `AFTER_HOURS_ACCESS_TOKEN`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_TERMINAL_READER_ID`
   - `STRIPE_MOTO_ENABLED` (`true` only after Stripe approves MOTO)
   - `SENDGRID_API_KEY`
   - `SENDGRID_FROM_EMAIL`
   - `SENDGRID_FROM_NAME`
   - `SENDGRID_REPLY_TO`
   - `GUEST_AUTH_SECRET`
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT`
6. For `DATABASE_URL`, use the connection string from your existing Railway Postgres instance.
7. Deploy the backend.
8. After deploy, copy the generated public backend URL.

### Connect to your existing Railway Postgres

If the database is already in the same Railway project:

1. Open the Postgres service.
2. Copy its `DATABASE_URL`.
3. Paste that into the backend service variable named `DATABASE_URL`.

If the database is in a different Railway project:

1. Open the existing Postgres project.
2. Copy the public or private connection string, depending on your setup.
3. Put that value in the backend service `DATABASE_URL`.

### Run the SQL

Use the Railway Postgres query window or your own SQL client and run [sql/001_rv_park_schema.sql](/Users/kadenwhite/Desktop/RVPark/sql/001_rv_park_schema.sql).

### Frontend service on Railway

1. Add another Railway service from the same GitHub repo.
2. Set its root directory to `client`.
3. Add `VITE_API_BASE_URL` and set it to your deployed backend URL, for example:
   - `https://api.riverparkrvresort.com/api`
4. Deploy the frontend.
5. Copy the frontend public URL.

### CORS

After the frontend deploys, update the backend `CLIENT_ORIGIN` and `PUBLIC_APP_URL` variables to the exact public frontend URL, for example:

- `https://your-frontend.up.railway.app`

`PUBLIC_APP_URL` is used for guest-facing payment links and must never be a localhost URL.

Then redeploy the backend.

## API Overview

- `GET /api/sites`
- `GET /api/customers`
- `POST /api/customers`
- `POST /api/availability/search`
- `POST /api/availability/plan`
- `POST /api/reservations`
- `GET /api/reservations/:id`
- `POST /api/reservations/:id/email-confirmation`
- `POST /api/guest/reservations/request-code`
- `POST /api/guest/reservations/sign-in`
- `POST /api/reservations/:id/payment-links`
- `POST /api/stripe/sync`
- `POST /api/stripe/webhooks`
- `GET /api/stripe/terminal/status`
- `POST /api/reservations/:id/terminal-payments`
- `POST /api/reservations/:id/check-in`

## Booking Rules Implemented

- `arrival_date` is inclusive
- `leave_date` is exclusive
- one reservation can have multiple site segments
- a site cannot have overlapping stays
- reservation segments must be contiguous and non-overlapping
- site-switch plans are generated automatically when one site cannot cover the full stay

## Admin office workspace

Admin opens to a daily overview with active sites booked tonight, guest arrivals, departures, site moves, pending reservations, and office shortcuts. Site moves between consecutive stays are shown separately from guest arrivals and departures. Pending bookings do not count as active occupancy. Overview guest rows open the reservation details.

All admin pages support `?admin=PAGE` links and retain the selected page when reloaded. Reservation and schedule site searches preserve the selected option while filtering, clear the filter when a new site is chosen, and are not overwritten by live refreshes. The reservation form supports typed arrival/departure dates alongside the calendar and prevents duplicate submissions while saving.

Run `npm test` and `npm run build` in `client` for the admin regressions and production build. The existing server checks remain `node --test src/*.test.js` in `server`.

### Payment follow-up and automatic late-arrival texts

Overview has a **Payment follow-up** list for active nightly/custom stays that have already started and still have unpaid nights or a balance. Filter by **Arrived yesterday** or **Departed unpaid**, search by guest/site/reservation number, and open **Review payment** to collect or record the payment. Settled bookings disappear on refresh/live updates; canceled bookings and future-only stays are excluded. Pending after-hours cash envelopes stay visible for verification. Monthly/yearly billing remains in its existing pages.

Before deploying automatic late-arrival texts, apply `sql/2026-10-10_late_arrival_texts.sql` to the existing database. It adds a delivery record and indexes; it does not send any texts or run automatically at startup. Existing Twilio message storage and stay-level check-ins must already be installed.

Confirmed same-day reservations created at or after **5:00 PM America/Los_Angeles** receive the existing late-arrival instructions, including a secure remaining-balance payment link when available. Public paid checkouts, admin-created/approved bookings, and QR cash-envelope bookings use the same sender. Explicit guest text opt-outs, missing phone numbers, canceled bookings, and guests already checked in for that visit are skipped. The server scans once per minute after 5 PM to recover interrupted booking callbacks. Exact cutoff and winter/daylight-saving offsets are tested.

Automatic and manual late-arrival texts share one durable claim per reservation/arrival date. Messages already accepted or with uncertain delivery are never blindly resent. Explicit provider throttling can retry after five minutes, up to three attempts. Other failed sends need staff attention in **Messages → Late arrival texts**. A failed SMS does not roll back a saved reservation. The database migration was verified using a temporary local PostgreSQL database and fake provider responses; no real test texts were sent.

## Reservation balance correction

The schedule normalizes PostgreSQL integer/bigint IDs before attaching payment history, stays and check-ins. Missing payment history must not cause fully paid mixed cash/card stays to acquire an extra card fee. Older payments without a recorded price type use a consistent allocation when their saved aggregate exactly matches the full bank or card total; explicitly typed payments and real partial balances remain authoritative. See [the October 27 balance audit](RESERVATION_BALANCE_AUDIT.md) for read-only verification against existing reservations. No data migration is needed.

## Bookkeeping finance workspace

Before deploying the upgraded bookkeeping screen, run `sql/2026-10-06_bookkeeping_finance.sql` against the existing Railway PostgreSQL database. It requires the existing bookkeeping and reservation-payment tables. It preserves existing records, adds indexed Stripe activity, sync metadata, bills, and reversible consolidation records, and protects linked expenses from inconsistent edits. Take a database backup first. No migration runs automatically at server startup.

The admin workspace includes Overview, Transactions, Documents, Reconcile, Bills, and Reports. Review AI suggestions before approving them. Uploaded originals are requested only when a transaction is expanded (or its document is explicitly opened). The AI queue is stored in document metadata, processes one document at a time under a database advisory lock, survives browser navigation, and recovers interrupted queued jobs after a server restart. Failed jobs require an explicit retry; waiting jobs can be cancelled without cancelling the active extraction.

On **Transactions**, the **Transaction source** filter separates receipts, invoices, bank statements, credit-card statements, tax documents, other uploaded documents, manual entries, Stripe, and office payments. **Bank & credit-card statements** shows both statement types together. Each row displays its source type; hover over it to see the source filename. Source types come from the original document for both pending and approved entries, including older files outside the Documents list. Deploy both the backend and frontend; no database migration is needed.

In **Documents → Document status**, **Ready for AI** shows uploaded files that are not waiting in the AI queue. **Queued for AI** shows waiting jobs separately. **Delete file** can permanently remove a file once all its transactions are excluded, including files previously reset or processed with no active entries. Confirmation names the file and its excluded-entry count; deletion also removes those entries, their line items, and previous AI extraction results so you can upload a clearer scan. Active entries must first be reset/excluded, and bill/consolidation links must be resolved before deletion. Waiting AI jobs must be cancelled and active processing must finish. The server locks the file and its entries, rechecks the confirmed count and links, and deletes database records in one transaction. Storage removal happens after database constraint checks and before commit; a storage failure restores the library record and all history for retry. Deploy frontend and backend; no new migration is required.

In **Documents**, **View transactions (count)** opens every transaction tied to that file across all dates, without the main ledger's filters or row cap. It shows pending/approved/excluded counts, active totals separated by currency and transaction type, and the original document alongside the list. Click an **Income**, **Expense**, **Transfer**, or other type total to show only that type in the document list; **All types** restores the complete list. The selected filter and visible count are shown, while document-wide totals stay unchanged. **Approve all pending (count)** reviews the pending entries in this document and selected type, including totals by currency, before approval. Already approved/excluded entries and other types/files stay unchanged. The server locks and rechecks the reviewed entries, rejects stale reviews or incomplete records, and records the approving admin and time in one transaction. Counts and reports refresh after saving; the document stays in review while any other pending entries remain. Type filters span currencies and also apply when **Show excluded history** is enabled. Toggle **Show excluded history** for transactions previously excluded or reset. **Review** expands the transaction editor directly under its row. **Save & close** or **Approve & close** updates the list and totals in place; **Close editor** returns to the same list and scroll position. The type filter is preserved, and automatic refresh pauses while the editor is open so it does not replace a draft. Errors keep the editor open. Changing an entry’s type moves the saved entry to its matching filter. **View all transactions from this file** remains available when opening older files from the main ledger. The view refreshes while AI processes a file and provides explicit queued, processing, failed and empty states. Compare counts and totals with the original: this display does not certify that AI found every transaction. Deploy both frontend and backend; no new migration is needed.

To start over from one imported file, use **Transactions → Reset entries from a file**, or **Documents → Reset entries** beside that file. Review every affected entry across all dates, including approved entries, and confirm the selected file. Reset excludes those entries from the books, preserves the original file and historical records, and records the previous statuses and admin in document metadata. Other files, manual entries, Stripe, and office payments are unaffected. Undo any consolidation links and unlink paid bills first; queued/processing files cannot be reset. Changed reviews are rejected until refreshed. After reset, use **Queue AI** in Documents to import a fresh set for review. Deploy both the backend and frontend; this feature requires no new migration beyond the existing finance migration.

If a queued document reports **SignatureDoesNotMatch**, the private file-storage request failed. Check the backend's bucket variables against the same bucket/environment's **Credentials** tab. Set `RAILWAY_BUCKET` to the globally unique **BUCKET** value, including its suffix; the display name shown as `RAILWAY_BUCKET_NAME` is not necessarily the S3 API name. Set `RAILWAY_BUCKET_ENDPOINT`, `RAILWAY_BUCKET_REGION`, `RAILWAY_BUCKET_ACCESS_KEY`, and `RAILWAY_BUCKET_SECRET_KEY` from that same tab. Railway's directly referenced `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` variables are also supported. Current `storageapi.dev` endpoints default to virtual-hosted URLs; set `RAILWAY_BUCKET_FORCE_PATH_STYLE=true` for a legacy bucket whose Credentials tab specifies path-style, or `false` for virtual-hosted style. Redeploy the backend after updating variables, then explicitly retry the failed documents. Storage errors now distinguish downloading the original from renaming it after extraction; server logs include the operation and provider request ID without credentials or signed URLs.

Use **Sync period** for the first import and for historical date ranges. The existing server `STRIPE_SECRET_KEY` must allow balance-transaction and balance reads. Recent 35-day history refreshes every 15 minutes while the backend is running. Balance IDs are upserted so repeat imports do not create duplicate payments. Live and test activity are separated. Stripe payments are not counted again from reservation payment events. Payouts and transfers move money but do not create income.

Reports are cash-basis USD: Stripe gross collections less refunds/disputes, office payment events, approved document/manual income, approved expenses, and processing fees. Advance deposits are collections, not earned/accrual revenue. Non-USD records are excluded without currency conversion. Statements and receipts may describe the same purchase: confirm a match before approving both; consolidation preserves the source records and can be undone. Stripe bank deposits should be transfers or matched to Stripe—not recorded as new income.

In **Reconcile → All transactions**, the reconciliation assistant scans every imported document/manual transaction across all dates, without the transaction-list display cap. It identifies overlapping statements, connects unique receipt/statement pairs, flags missing receipts and unconnected receipts, and surfaces ambiguous matches or differing amounts. Currency/type totals show the remaining difference; equal totals alone do not prove reconciliation, and this does not validate statement opening/closing balances or extraction completeness. Matching operates on the existing AI-extracted facts without sending another copy of financial documents to a model.

**Review cleanup** lists each proposed exclusion and the final kept record before applying all clear consolidations in one database transaction. Receipt matching requires exact normalized merchants, amounts, currencies and types, compatible card/account suffixes, and dates within three days, with a unique match in both directions. Overlapping statement entries also require identical explicit accounts, the same statement type, different source documents, and no repeated identical purchases within a document. Receipt-only duplicates, transfers, amount differences, ambiguous purchases and missing factual fields require review. Approved entries and records supporting paid bills/existing consolidations take priority as keepers. The server rechecks a scan fingerprint under database locks and rejects stale cleanup previews. All exclusions retain source files, previous statuses and admin attribution in consolidation history, with individual undo. Future scans follow those links so matched receipts remain connected. Single-statement comparisons use the same global assignment. This reuses the existing finance migration; no additional migration is needed.

Bills are a due-date tracker. They do not add expenses themselves. Record the actual payment as an approved expense and link it to the bill; the same expense cannot pay two tracked bills. Nothing in this workspace initiates a bank payment. Export the selected period's ledger CSV for your accountant.

This is a practical cash-basis bookkeeping workspace, not full QuickBooks parity: automatic bank feeds, double-entry accounting/balance sheets, payroll, tax filing, and accrual/deferred-revenue accounting are not implemented. Historical office collections predating payment-event records must be reviewed separately.

Verification: run `npm run build` in `client` and `node --test src/*.test.js` in `server`.
