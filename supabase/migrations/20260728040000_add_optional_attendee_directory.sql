alter table public.bookings
  drop constraint if exists bookings_attendees_check;

alter table public.bookings
  add constraint bookings_attendees_check
  check (length(btrim(attendees)) <= 500);

create table if not exists public.attendee_directory (
  email text primary key,
  name text not null default '',
  source text not null default 'manual',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendee_directory_email_check check (
    email = lower(btrim(email))
    and length(email) between 3 and 120
    and position('@' in email) > 1
  ),
  constraint attendee_directory_name_check check (
    length(name) <= 120
  ),
  constraint attendee_directory_source_check check (
    source in ('google', 'manual')
  )
);

create index if not exists attendee_directory_name_idx
  on public.attendee_directory (lower(name), email)
  where enabled;

alter table public.attendee_directory enable row level security;

revoke all on table public.attendee_directory
  from public, anon, authenticated;

grant select, insert, update on table public.attendee_directory
  to service_role;

comment on table public.attendee_directory is
  'Server-only shared attendee suggestions imported from Google Contacts or remembered from bookings.';

comment on column public.attendee_directory.source is
  'google for Enrollment imports; manual for emails remembered from bookings.';

comment on column public.bookings.attendees is
  'Comma-separated attendee email addresses. Empty means a solo booking.';
