create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_email text not null,
  refresh_token_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_connections_email_check check (
    google_email = lower(btrim(google_email))
    and length(google_email) between 3 and 120
    and position('@' in google_email) > 1
  ),
  constraint google_calendar_connections_token_check check (
    length(refresh_token_ciphertext) between 40 and 8192
  )
);

alter table public.google_calendar_connections enable row level security;

revoke all on table public.google_calendar_connections
  from public, anon, authenticated;

grant select, insert, update, delete on table public.google_calendar_connections
  to service_role;

alter table public.bookings
  add column if not exists calendar_owner_id uuid
    references auth.users(id) on delete set null,
  add column if not exists calendar_event_id text,
  add column if not exists calendar_sync_state text not null default 'not_configured',
  add column if not exists calendar_sync_updated_at timestamptz;

alter table public.bookings
  drop constraint if exists bookings_calendar_sync_state_check;

alter table public.bookings
  add constraint bookings_calendar_sync_state_check check (
    calendar_sync_state in (
      'not_configured',
      'not_connected',
      'synced',
      'failed'
    )
  );

create index if not exists bookings_calendar_owner_idx
  on public.bookings (calendar_owner_id)
  where calendar_owner_id is not null;

create unique index if not exists bookings_calendar_event_id_key
  on public.bookings (calendar_owner_id, calendar_event_id)
  where calendar_event_id is not null;

comment on table public.google_calendar_connections is
  'Server-only encrypted Google OAuth refresh tokens used to manage a booker’s primary Calendar events.';

comment on column public.google_calendar_connections.refresh_token_ciphertext is
  'AES-256-GCM encrypted provider refresh token. Never expose this value to browser clients.';

comment on column public.bookings.calendar_event_id is
  'Google Calendar event ID for the booking. Empty for bookings created before Calendar sync or when sync is unavailable.';

comment on column public.bookings.calendar_sync_state is
  'Calendar synchronization result. A failed sync does not undo a confirmed room booking.';
