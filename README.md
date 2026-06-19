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

## Local Setup

### 1. Backend

Create `server/.env` from [server/.env.example](/Users/kadenwhite/Desktop/RVPark/server/.env.example).

Required values:

- `DATABASE_URL`
- `PORT`
- `CLIENT_ORIGIN`
- `APP_PASSCODE`

Install and run yourself:

```bash
cd server
npm install
npm run dev
```

### 2. Frontend

Create `client/.env` from [client/.env.example](/Users/kadenwhite/Desktop/RVPark/client/.env.example).

Required value:

- `VITE_API_BASE_URL`
- `VITE_APP_PASSCODE`

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
   - `APP_PASSCODE`
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
   - `https://your-api.up.railway.app/api`
4. Add `VITE_APP_PASSCODE` and set it to the same value as backend `APP_PASSCODE`.
5. Deploy the frontend.
6. Copy the frontend public URL.

### CORS

After the frontend deploys, update the backend `CLIENT_ORIGIN` variable to the exact frontend URL, for example:

- `https://your-frontend.up.railway.app`

Then redeploy the backend.

## API Overview

- `GET /api/sites`
- `GET /api/customers`
- `POST /api/customers`
- `POST /api/availability/search`
- `POST /api/availability/plan`
- `POST /api/reservations`
- `GET /api/reservations/:id`

## Booking Rules Implemented

- `arrival_date` is inclusive
- `leave_date` is exclusive
- one reservation can have multiple site segments
- a site cannot have overlapping stays
- reservation segments must be contiguous and non-overlapping
- site-switch plans are generated automatically when one site cannot cover the full stay
