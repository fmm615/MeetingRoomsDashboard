# Playbook Meeting Rooms MVP

A Google-authenticated meeting-room booking application with a Playbook-branded interface, private management links, and Supabase-backed conflict protection.

## Requirements

- Node.js 24 or newer
- npm
- A Supabase project

Install the locked dependencies:

```bash
npm install
```

## Supabase setup

Copy `.env.example` to `.env` and set the project credentials:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=your-server-only-secret-key
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_browser-safe-key
```

Legacy projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

Apply the SQL files in `supabase/migrations/` in filename order before starting
the app. The initial migration creates and seeds the room catalogue, bookings,
room blocks, database functions, conflict constraints, and server-only
permissions. The participant migration safely upgrades projects that already
applied the initial schema. The availability-broadcast migration adds
privacy-safe Realtime invalidation events for bookings and room blocks.
The attendee-directory migration makes attendees optional and creates a
server-only shared directory for Enrollment imports and previously used
attendee emails.

The publishable key is intentionally browser-safe. Never expose the Supabase
secret key to browser code.

## Google login and Contacts setup for local testing

Normal login requests only the basic Google identity scopes (`openid`, email,
and profile). Google Contacts access is requested separately and only when a
signed-in user selects **Import/refresh Enrollment**. Google Calendar access is
not requested yet.

### 1. Create the Google OAuth client

In the Google Cloud Console:

1. Open Google Auth Platform for the company project.
2. Configure Branding and Audience. Use the internal audience when the
   organization uses Google Workspace; otherwise add the intended testers.
3. Under Data Access, include `openid`, `userinfo.email`, and
   `userinfo.profile`.
4. Create a client with application type **Web application**.
5. Add this Authorized JavaScript origin:

   ```text
   http://127.0.0.1:8080
   ```

6. Add the Supabase callback shown on the Google provider page as an
   Authorized redirect URI. For the current project it is:

   ```text
   https://hubidhirgdjociudtjcz.supabase.co/auth/v1/callback
   ```

7. Copy the generated Client ID and Client Secret.

### 2. Enable Google in Supabase

In Supabase Dashboard:

1. Open **Authentication → Sign In / Providers → Google**.
2. Enable Google, paste the Client ID and Client Secret, and save.
3. Open **Authentication → URL Configuration**.
4. Add this Redirect URL:

   ```text
   http://127.0.0.1:8080/**
   ```

### 3. Enable the Enrollment contact import

In Google Cloud Console:

1. Open **APIs & Services → Library** and enable **Google People API**.
2. Open **Google Auth Platform → Data Access → Add or remove scopes**.
3. Add this read-only scope:

   ```text
   https://www.googleapis.com/auth/contacts.readonly
   ```

4. If the OAuth audience is External and still in Testing, add each person who
   will test the import as a test user.
5. Keep the shared team contacts under a Google Contacts label named exactly
   `Enrollment`.

### 4. Restrict company domains (optional for the first test)

To reject Google accounts outside approved company domains, add a
comma-separated list to `.env`:

```bash
GOOGLE_ALLOWED_DOMAINS=playbook.example,oh.example
```

When this variable is absent, any verified Google account can sign in. The API
still verifies the Supabase session and requires Google as the identity
provider.

## Run locally

```bash
npm start
```

Open [http://127.0.0.1:8080/book](http://127.0.0.1:8080/book).

The first page is now a Google sign-in gate. After successful login:

- the header shows the signed-in account and a sign-out button;
- the booking owner name and organizer email come from Google and are read-only;
- every booking API request includes the Supabase access token;
- the server verifies that token with Supabase before reading or changing data;
- attendees are optional, so an empty selection creates a solo booking;
- saved contacts are searchable and manual attendee emails are remembered;
- **Import/refresh Enrollment** asks for read-only Contacts permission and
  copies only that label into the shared attendee directory.

`npm start` creates the browser bundle with esbuild and starts the Node server. Supabase is the only runtime database.

## Included

- Four centrally configured spaces: Meeting Room, Standing Workstations, Innovation Hub, and Quiet Pods
- Compact room cards with selected-date availability and accessible guidelines drawers
- 30-minute start times and room-specific duration choices
- Bahrain workweek rules: Friday and Saturday are visibly unavailable and rejected by both the API and database
- Framer Motion page, card, date, slot, drawer, error, loading, and confirmation transitions
- Reduced-motion support
- Google sign-in with server-verified Supabase sessions
- Google-supplied booking owner name and organizer email
- Required booking team (PLAYBOOK, O&H, or joint) and meeting title or purpose; optional attendees and notes
- Searchable saved attendees, manual email entry, and read-only Google Contacts `Enrollment` import
- Server-side room, date, past-time, office-hours, and duration validation
- Atomic Postgres exclusion constraints preventing confirmed room/time overlaps
- Postgres triggers protecting weekends, room blocks, active-room rules, and durations
- Booking confirmation with a unique reference
- 192-bit private edit/cancel token
- SHA-256 token hashes; raw management tokens are never stored
- Private management links at `/booking/[token]`
- Private-link editing of date, start time, duration, team, owner, email, attendees, title, and notes
- Past bookings cannot be recycled into future reservations
- Idempotent cancellation that immediately returns time to availability
- Supabase Broadcast updates open calendars immediately after availability changes
- Realtime payloads contain only the affected date and room
- Availability responses never expose names, email, attendees, notes, references, or tokens
- Responsive and keyboard-accessible drawers
- Security headers and no-store API responses

Room duration rules:

- Meeting Room: 15-minute increments, up to 120 minutes
- Standing Workstations: 15, 30, 45, or 60 minutes
- Innovation Hub: 15-minute increments, up to 120 minutes
- Quiet Pods: 30 or 45 minutes

Profiles, roles, team management, password reset, calendar sync, and account settings are intentionally excluded from this milestone.

## Recommended internal process

The reviewed flow had four practical gaps: team ownership was ambiguous,
attendees were not recorded, the optional organizer email was missing from the
form, and existing Supabase projects needed a safe schema upgrade. Those gaps
are covered by this version.

Use one shared calendar process:

1. Choose a Sunday–Thursday date, an available room, a start time, and a
   duration.
2. Record PLAYBOOK, O&H, or a joint booking; the meeting title; optional
   attendees; and optional notes. Google supplies the owner name and email.
3. Keep the booking reference and send the private management link to the
   meeting owner.
4. Use that link for all edits and cancellations. The original slot is released
   only after a valid change or cancellation succeeds.

Supabase remains the single source of truth. If two people submit the same room
and time together, the database confirms one and rejects the other with a
conflict response. Public availability stays limited to busy intervals; owner,
attendee, email, title, and notes remain behind the private booking link.
Realtime tells open calendars which date and room changed, then each calendar
refetches the protected availability API.

## Routes

- `/` or `/book` — room availability and booking flow
- `/book/details` — booking application route
- `/booking/[token]` — confirmation, editing, and cancellation
- `/api/auth-config` — browser-safe Supabase Auth URL and publishable key
- `/api/rooms` — active room catalogue
- `/api/availability` — non-PII busy intervals
- `/api/realtime-config` — browser-safe Realtime URL and publishable key
- `/api/attendees` — protected saved-attendee suggestions
- `/api/attendees/import-google` — protected read-only Enrollment import
- `/api/bookings` — create a booking
- `/api/bookings/[token]` — view, edit, or cancel via private token

Except for the two browser-safe configuration routes, all API routes require a valid Google-authenticated Supabase access token.

## Tests

Run the complete static, production-build, API, and Postgres-policy gate:

```bash
npm run check
```

The API tests use an in-memory store double, not a second database. The Supabase migrations are checked for overlap, weekend, room-block, RLS, service-role, Realtime payload, and browser-configuration protections.
The Google Contacts tests use a mock People API and do not access a real account.

The optional browser suites require Chrome remote debugging and a configured local Supabase project:

```bash
npm run test:browser
npm run test:motion
```

## Deployment

Deployment is intentionally deferred until Google login has been tested
locally. The existing `api/index.js` and `vercel.json` remain available for the
later Vercel step.

- Apply all Supabase migrations in filename order before deployment.
- Configure `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
  and optional `GOOGLE_ALLOWED_DOMAINS`.
- Serve the application over HTTPS.
- Restrict access to the intended office or team.
- Set `PORT` and `HOST` only for local or self-hosted operation.

