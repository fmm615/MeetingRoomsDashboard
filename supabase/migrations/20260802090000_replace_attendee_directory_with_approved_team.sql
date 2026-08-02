-- The attendee picker is a curated team directory. One-off invitees remain
-- valid booking attendees, but are deliberately not stored as future choices.
delete from public.attendee_directory;

insert into public.attendee_directory (email, name, source, enabled)
values
  ('wafa@get-playbook.com', 'Wafa AlObaidat', 'manual', true),
  ('shreya@get-playbook.com', 'Shreya Rammohan', 'manual', true),
  ('nada@get-playbook.com', 'Nada Darwish', 'manual', true),
  ('accounts@get-playbook.com', 'Fatema Hasan', 'manual', true),
  ('humanresources@get-playbook.com', 'Zahraa Mohsen', 'manual', true),
  ('operations@get-playbook.com', 'Walaa Alaali', 'manual', true),
  ('leaddesigner@get-playbook.com', 'Latifa Al Ali', 'manual', true),
  ('marketingrep@get-playbook.com', 'Sara Salami', 'manual', true),
  ('community@get-playbook.com', 'Nabaa AlHebail', 'manual', true),
  ('memberexp@get-playbook.com', 'Sara Hammad', 'manual', true),
  ('product@get-playbook.com', 'Fayeza Ahmed', 'manual', true),
  ('developer@get-playbook.com', 'Mohammed Mahmood', 'manual', true),
  ('systems@get-playbook.com', 'Alya Mahmood', 'manual', true),
  ('admin@get-playbook.com', 'Playbook admin', 'manual', true),
  ('accounting@get-playbook.com', 'Shaima Faisal', 'manual', true),
  ('growth@get-playbook.com', 'Fatema AlBasri', 'manual', true),
  ('devrep@obaiandhill.com', 'Ranya', 'manual', true),
  ('gdesigner@obaiandhill.com', 'Sahar', 'manual', true),
  ('customerrep@obaiandhill.com', 'Fatema', 'manual', true),
  ('accountrepresentative@obaiandhill.com', 'Samar', 'manual', true);
