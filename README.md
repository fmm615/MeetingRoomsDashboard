# Playbook Meeting Rooms MVP

A no-login meeting-room booking application with a Playbook-branded interface, private management links, and Supabase-backed conflict protection.

## Requirements

- Node.js 24 or newer
- npm
- A Supabase project

Install the locked dependencies:

```bash
npm install
```

## Supabase setup

Copy `.env.example` to `.env` and set the server-only credentials:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=your-server-only-secret-key
```

Legacy projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

Apply `supabase/migrations/20260728000000_initial_booking_schema.sql` to the Supabase project before starting the app. The migration creates and seeds the room catalogue, bookings, room blocks, database functions, conflict constraints, and server-only permissions.

Never expose either Supabase secret key to browser code.

## Run locally

```bash
npm start
```

Open [http://127.0.0.1:8080/book](http://127.0.0.1:8080/book).

`npm start` creates the browser bundle with esbuild and starts the Node server. Supabase is the only runtime database.

## Included

- Four centrally configured spaces: Meeting Room, Standing Workstations, Innovation Hub, and Quiet Pods
- Compact room cards with selected-date availability and accessible guidelines drawers
- 15-minute start times and room-specific duration choices
- Bahrain workweek rules: Friday and Saturday are visibly unavailable and rejected by both the API and database
- Framer Motion page, card, date, slot, drawer, error, loading, and confirmation transitions
- Reduced-motion support
- Required booked-by name and meeting title or purpose; optional notes
- Server-side room, date, past-time, office-hours, and duration validation
- Atomic Postgres exclusion constraints preventing confirmed room/time overlaps
- Postgres triggers protecting weekends, room blocks, active-room rules, and durations
- Booking confirmation with a unique reference
- 192-bit private edit/cancel token
- SHA-256 token hashes; raw management tokens are never stored
- Private management links at `/booking/[token]`
- Private-link editing of date, start time, duration, name, title, and notes
- Past bookings cannot be recycled into future reservations
- Idempotent cancellation that immediately returns time to availability
- Availability responses that never expose names, email, notes, references, or tokens
- Responsive and keyboard-accessible drawers
- Security headers and no-store API responses

Room duration rules:

- Meeting Room: 15-minute increments, up to 120 minutes
- Standing Workstations: 15, 30, 45, or 60 minutes
- Innovation Hub: 15-minute increments, up to 120 minutes
- Quiet Pods: 30 or 45 minutes

Profiles, user accounts, roles, team management, password reset, and account settings are intentionally excluded from this MVP.

## Routes

- `/` or `/book` — room availability and booking flow
- `/book/details` — booking application route
- `/booking/[token]` — confirmation, editing, and cancellation
- `/api/rooms` — active room catalogue
- `/api/availability` — non-PII busy intervals
- `/api/bookings` — create a booking
- `/api/bookings/[token]` — view, edit, or cancel via private token

## Tests

Run the complete static, production-build, API, and Postgres-policy gate:

```bash
npm run check
```

The API tests use an in-memory store double, not a second database. The Supabase migration is checked for overlap, weekend, room-block, RLS, and service-role protections.

The optional browser suites require Chrome remote debugging and a configured local Supabase project:

```bash
npm run test:browser
npm run test:motion
```

## Deployment

The included `api/index.js` and `vercel.json` support Vercel deployment.

- Apply the Supabase migration before the first deployment.
- Configure `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as server-only environment variables.
- Serve the application over HTTPS.
- Restrict access to the intended office or team.
- Set `PORT` and `HOST` only for local or self-hosted operation.

The private management link is the booking credential. Anyone who receives it can edit or cancel that booking.
