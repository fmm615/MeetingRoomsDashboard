-- Seed the approved O&H team members so they are immediately searchable in
-- the attendee selector. Existing names are preserved if a contact has
-- already been imported from Google or used in an earlier booking.
insert into public.attendee_directory (email, name, source, enabled)
values
  ('devrep@obaiandhill.com', 'Ranya', 'manual', true),
  ('gdesigner@obaiandhill.com', 'Sahar', 'manual', true),
  ('customerrep@obaiandhill.com', 'Fatema', 'manual', true),
  ('accountrepresentative@obaiandhill.com', 'Samar', 'manual', true)
on conflict (email) do update
set
  enabled = true,
  updated_at = now(),
  name = case
    when btrim(public.attendee_directory.name) = '' then excluded.name
    else public.attendee_directory.name
  end;
