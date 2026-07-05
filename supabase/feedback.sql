create table if not exists feedback_entries (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('feedback', 'complaint')),
  status text not null default 'new' check (status in ('new', 'reviewing', 'resolved')),
  name text not null,
  email text,
  phone text,
  patient_code text,
  report_id text,
  message text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists feedback_messages (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback_entries(id) on delete cascade,
  responder_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists feedback_entries_created_at_idx on feedback_entries(created_at desc);
create index if not exists feedback_entries_status_idx on feedback_entries(status);
create index if not exists feedback_messages_feedback_id_idx on feedback_messages(feedback_id);

alter table feedback_entries enable row level security;
alter table feedback_messages enable row level security;

drop policy if exists "authenticated read feedback entries" on feedback_entries;
create policy "authenticated read feedback entries"
on feedback_entries for select to authenticated
using (true);

drop policy if exists "authenticated update feedback entries" on feedback_entries;
create policy "authenticated update feedback entries"
on feedback_entries for update to authenticated
using (true)
with check (true);

drop policy if exists "authenticated read feedback messages" on feedback_messages;
create policy "authenticated read feedback messages"
on feedback_messages for select to authenticated
using (true);

drop policy if exists "authenticated insert feedback messages" on feedback_messages;
create policy "authenticated insert feedback messages"
on feedback_messages for insert to authenticated
with check (true);

-- Public feedback submission is routed through the backend service-role endpoint.
-- Do not add broad anon select/update policies for patient feedback.
