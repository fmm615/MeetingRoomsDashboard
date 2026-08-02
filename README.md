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
server-only shared directory. The approved-team migration replaces existing
saved contacts with the curated Playbook and O&H attendee list. The Google
Calendar migration adds encrypted, server-only Google refresh-token storage
and Calendar event references for bookings.

The publishable key is intentionally browser-safe. Never expose the Supabase
secret key to browser code.

## Google login and Calendar setup

Normal login requests only the basic Google identity scopes (`openid`, email,
profile) plus the narrow Calendar scope needed to create and update events on
the signed-in booker's primary Calendar.

### 1. Create the Google OAuth client

In the Google Cloud Console:

1. Open Google Auth Platform for the company project.
2. Configure Branding and Audience. Use the internal audience when the
   organization uses Google Workspace; otherwise add the intended testers.
3. Under Data Access, include `openid`, `userinfo.email`, and
   `userinfo.profile`.
4. Create a client with application type **Web application**.
5. Add the origin for each environment that will use Google sign-in:

   ```text
   http://127.0.0.1:8080
   ```
   https://meeting-rooms-dashboard.vercel.app

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
4. Add these Redirect URLs:

   ```text
   http://127.0.0.1:8080/**
   ```

   https://meeting-rooms-dashboard.vercel.app/**
### 3. Enable Google Calendar sync

1. In Google Cloud Console, enable **Google Calendar API** under **APIs & Services → Library**.
2. Under **Google Auth Platform → Data Access**, add both:

   ```text
   https://www.googleapis.com/auth/calendar.events.owned
   https://www.googleapis.com/auth/calendar.events.freebusy
   ```
3. Add these server-only values to local `.env`, using the same Google OAuth Web client configured in Supabase:

   ```bash
   GOOGLE_CALENDAR_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
   GOOGLE_CALENDAR_CLIENT_SECRET=your-google-oauth-client-secret
   GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY=base64-encoded-32-byte-random-key
   ```

4. Generate the encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Do not change it after people connect Calendar.
5. Apply the Calendar SQL migration, restart the local app, then sign in again or choose **Connect calendar** in the header.

The app encrypts the Google refresh token before storage. A successful booking creates an event in the booker's primary Calendar and sends invitations to selected attendees; edits update it and cancellation removes it. The private management link is never included in the event.

After adding or changing a Calendar scope, each existing user must select **Reconnect calendar** and approve the new Google consent screen once.
Before saving a booking, the app checks the booker and selected attendees using Google Calendar free/busy data. It returns only `available`, `busy`, or `unknown`—never event titles, notes, or attendees. A busy or unavailable result shows a warning and requires the booker to deliberately choose **Book anyway**. The check can only see calendars that Google Workspace makes visible to the signed-in booker; colleagues must share free/busy availability or an administrator must configure an appropriate company-wide solution.

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
- saved contacts begin with the curated Playbook and O&H team list;
- a booker can type any valid email address to invite a person outside that
  list, and the address is permanently saved as a future suggestion.

`npm start` creates the browser bundle with esbuild and starts the Node server. Supabase is the only runtime database.

## Included

- Four centrally configured spaces: Meeting Room, Standing Workstations, Innovation Hub, and Quiet Pods
- Compact room cards with selected-date availability and accessible guidelines drawers
- 30-minute start times and room-specific duration choices
- Bahrain workweek rules: Friday and Saturday are visibly unavailable and rejected by both the API and database
- Framer Motion page, card, date, slot, drawer, error, loading, and confirmation transitions
- Reduced-motion support
- Google sign-in with server-verified Supabase sessions
- Google Calendar events in the signed-in booker’s primary calendar, with attendee invitations and update/cancellation notifications
- Pre-confirmation Google free/busy checks for the booker and selected attendees, with a deliberate **Book anyway** override when a calendar is busy or cannot be checked
- Google-supplied booking owner name and organizer email
- Required booking team (PLAYBOOK, O&H, or joint) and meeting title or purpose; optional attendees and notes
- Searchable curated team attendees plus permanently remembered manual email invites
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

Profiles, roles, team management, password reset, and account settings are intentionally excluded from this milestone.

## Recommended internal process

The reviewed flow had four practical gaps: team ownership was ambiguous,
attendees were not recorded, the optional organizer email was missing from the
form, and existing Supabase projects needed a safe schema upgrade. Those gaps
are covered by this version.

Use one shared calendar process:

1. Choose a Sunday–Thursday date, an available room, a start time, and a
   duration.
2. Record PLAYBOOK, O&H, or a joint booking; the meeting title; optional
   attendees; and optional notes. Google supplies the owner name and email, then Calendar sends attendee invitations when connected.
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
- `/api/attendees/import-google` — retired; returns `410 Gone` to keep the directory curated
- `/api/calendar/status` — protected Calendar connection status
- `/api/calendar/connect` — saves an encrypted Calendar refresh token after Google consent
- `/api/calendar/availability` — returns only `available`, `busy`, or `unknown` for the proposed schedule
- `/api/bookings` — create a booking
- `/api/bookings/[token]` — view, edit, or cancel via private token

Except for the two browser-safe configuration routes, all API routes require a valid Google-authenticated Supabase access token.

## Tests

Run the complete static, production-build, API, and Postgres-policy gate:

```bash
npm run check
```

The API tests use an in-memory store double, not a second database. The Supabase migrations are checked for overlap, weekend, room-block, RLS, service-role, Realtime payload, and browser-configuration protections.
The Calendar tests use mocked Google OAuth and Calendar endpoints; they never access
a real calendar.

The optional browser suites require Chrome remote debugging and a configured local Supabase project:

```bash
npm run test:browser
npm run test:motion
```

## Deployment

The production application is deployed on Vercel:
[meeting-rooms-dashboard.vercel.app](https://meeting-rooms-dashboard.vercel.app/book).
The Vercel project is `meeting-rooms-dashboard`; it can be connected to the
GitHub repository for automatic deployments, or deployed manually with:

```bash
npx vercel --prod
```

Set the following environment variables in **Vercel → Project → Environment
Variables** for Production (and Preview if it needs the same integrations):

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_PUBLISHABLE_KEY`
- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`
- `GOOGLE_ALLOWED_DOMAINS` (optional allow-list of Google Workspace domains)

The Calendar client secret, token-encryption key, and Supabase secret key are
server-only values: never prefix them with `VITE_`, expose them in browser code,
or commit them to `.env` files. Redeploy after changing an environment value.

- Apply all Supabase migrations in filename order before deployment.
- Configure `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
  optional `GOOGLE_ALLOWED_DOMAINS`, `GOOGLE_CALENDAR_CLIENT_ID`,
  `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`.
- Serve the application over HTTPS.
- Restrict access to the intended office or team.
- Set `PORT` and `HOST` only for local or self-hosted operation.

