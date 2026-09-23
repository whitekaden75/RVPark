# Saved text messages

1. Run `sql/2026-09-21_text_messages.sql` against the backend's Postgres database before deploying.
   Also run `sql/2026-09-21_arrival_text_reminders.sql` for the bulk arrival reminder button.
2. Set backend variables `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_PHONE_NUMBER` (E.164, e.g. `+15415551234`) or `TWILIO_MESSAGING_SERVICE_SID`.
3. Also set `TWILIO_AUTH_TOKEN` to the **account Auth Token**, not the API key secret. Set `TWILIO_WEBHOOK_BASE_URL` to the public HTTPS backend origin, without a path or trailing slash.
4. Deploy the backend and frontend. Install the updated backend dependencies with `npm ci`.
5. In Twilio, set the number's incoming messaging webhook to `https://YOUR-BACKEND/api/twilio/incoming`, **HTTP POST**. If using a Messaging Service, configure its incoming handling to use this webhook (or defer to the number's webhook). The app sets `https://YOUR-BACKEND/api/twilio/status` on each outgoing message automatically.
6. Open Text Messages in Admin. Click **Sync recent Twilio history** to import the latest 50 account messages filtered to the configured phone number. This is a recent-history import, not a full historical backfill.
7. Send a test from the site to your own consenting phone, reply to it, and confirm both appear after refresh, with delivery status and matching guest/booking details. Reload the page to confirm persistence.

The inbox reads from Postgres. Webhooks are signature-validated using Twilio's SDK before saving; admin access remains required for history and sending. Unique message SIDs make webhook retries and imports idempotent. The inbox updates through existing server events with a 15-second polling fallback. All bookings for a matching normalized phone number are shown; a match is contextual information, not proof of identity.

Outgoing messages sent through this server, including monthly billing messages, are saved. Arrival reminders and payment-link text buttons open a draft in the site's Text Messages composer; staff review it and press Send. Texts sent outside the app through Twilio can be imported with recent-history sync. Media counts are stored, but media viewing is not implemented.

If Twilio accepts a send but the database subsequently fails, the app warns against resending; use recent-history sync to recover the record. Configure both webhook variables to receive delivery updates. Missing table errors require running the migration. A 403 webhook response means the account token, exact public URL, account SID, or signature did not match. Do not disable signature validation.

Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security

Incoming live texts also trigger push alerts on devices subscribed to admin notifications, using the existing VAPID configuration and `admin_push_subscriptions` table. Only active admin accounts are included. Alerts show the sender's number and a short message preview; tapping opens Text Messages. Existing subscribers do not need to opt in again. Webhook retries, outgoing status updates, and history imports do not generate repeat alerts. Expired subscriptions are removed. Push delivery is best-effort and a push failure never rejects an already saved incoming message. This feature requires no additional migration beyond the existing messaging and admin-push tables.

## Tomorrow’s arrival texts

Text Messages includes a recipient list and **Send all tomorrow’s reminders** button. Tomorrow is calculated on the server in Pacific time. Only active bookings whose first site stay begins tomorrow are included, so ongoing guests moving sites are excluded. Each booking receives its own personalized message, including its final departure date. Invalid phone numbers are skipped. Individual arrival actions open the same server-generated template in the site's composer.

Bulk sends are claimed per booking and arrival date in `arrival_text_reminders`. Repeated clicks and concurrent sessions skip previously accepted or in-progress sends. Explicit provider rejections can be retried; uncertain responses require reviewing Twilio history first. A process interruption can leave a `sending` record requiring review. Manual composer sends are separate from this bulk-send tracking. No reminders are sent automatically on a schedule.
