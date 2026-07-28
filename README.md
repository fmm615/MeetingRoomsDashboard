# Playbook Meeting Rooms MVP

A no-login meeting-room booking application with a Playbook-branded interface, private management links, and SQLite-backed conflict protection.

## Requirements

- Node.js 24 or newer
- npm

Install the locked dependencies:

```bash
npm install
```

## Run locally

```bash
npm start
```

Open [http://127.0.0.1:8080/book](http://127.0.0.1:8080/book).

`npm start` creates a minified browser bundle with esbuild, then starts the Node server. The SQLite database is created automatically at `data/meeting-rooms.sqlite`.

## Included

- Four centrally configured spaces: Meeting Room, Standing Workstations, Innovation Hub, and Quiet Pods
- Compact room cards with selected-date availability and accessible guidelines drawers
- 15-minute start times and room-specific duration choices
- Framer Motion page, card, date, slot, drawer, error, loading, and confirmation transitions
- Shared motion variants with calm Playbook timing and cubic-bezier easing
- Reduced-motion support that removes translation, scale, stagger, and delayed focus
- Stable loading-button dimensions and restrained loading skeletons
- Required booked-by name and meeting title or purpose; optional notes
- Server-side room, date, past-time, office-hours, and room-specific duration validation
- Atomic database triggers preventing room/time overlaps
- Blocked-period storage and database conflict protection
- Booking confirmation with a unique reference
- 192-bit private edit/cancel token
- SHA-256 token hashes in the database; raw management tokens are never stored
- Private management links at `/booking/[token]`
- Private-link editing of the booking date, start time, duration, name, title, and notes
- Token-aware edit availability that excludes the booking itself while preserving conflict protection
- Past bookings cannot be recycled into future reservations through an edit link
- Idempotent cancellation
- Cancellation immediately returns the time to availability
- Availability responses expose busy intervals without names, email, notes, or tokens
- Slack-ready booking responses with room name, location, start/end times, duration, booked by, title, and notes
- Responsive and keyboard-accessible booking drawer
- Security headers and no-store API responses

Room duration rules:

- Meeting Room: 15-minute increments, up to 120 minutes
- Standing Workstations: 15, 30, 45, or 60 minutes
- Innovation Hub: 15-minute increments, up to 120 minutes
- Quiet Pods: 30 or 45 minutes

The large admin dashboard, profiles, user accounts, roles, team management, password reset, and account settings are intentionally excluded from this MVP.

## Routes

- `/` or `/book` — room availability and booking flow
- `/book/details` — booking application route
- `/booking/[token]` — confirmation, editing, and cancellation

## Tests

Run the complete static, production-build, and API/database gate:

```bash
npm run check
```

The individual checks are:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

The browser test requires a Chrome instance with remote debugging plus an isolated application server. It exercises creation, date/time rescheduling, availability movement, cancellation, and the 390px responsive layout:

```bash
npm run test:browser
```

The dedicated motion browser suite checks normal motion, reduced motion, mobile drawer behavior, focus/inert state, loading dimensions, and the absence of continuous decorative animation:

```bash
npm run test:motion
```

The browser presentation lives in `src/main.tsx`; shared variants and accessibility-aware motion settings live in `src/motion-config.ts`. The Node API and SQLite conflict logic remain server-side and unchanged by the animation layer.

## Database migration

On first start, a version-zero database is migrated transactionally to the current schema:

- Existing room IDs are retained.
- Existing booking IDs, references, token hashes, status, details, and timestamps are retained.
- Legacy 30-minute slot indexes are multiplied by two so their wall-clock times remain unchanged with the new 15-minute model.
- A pre-migration backup is created beside the database with the suffix `.pre-room-rules-v0.backup`.

The migration is idempotent and is covered by a populated legacy-database test.

## Deployment

For an internal deployment:

- Serve the application behind HTTPS so private management links are encrypted in transit.
- Restrict access at the network or reverse-proxy layer to the intended office/team.
- Back up `data/meeting-rooms.sqlite`.
- Set `DATABASE_PATH` if the database should live outside the project folder.
- Set `PORT` to change the default port of `8080`.
- Set `HOST` when binding through an internal reverse proxy; the default is `127.0.0.1`.

The private link is the booking credential. Anyone who receives it can edit or cancel that booking.
