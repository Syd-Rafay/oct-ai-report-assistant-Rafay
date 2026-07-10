-- AFIO multi-department/module upgrade.
-- Run after the existing OCT schema. This keeps old records working while
-- adding department separation for OCT/VKG, Corneal, and Retina workflows.

create extension if not exists "pgcrypto";

create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique not null,
  admin_email text,
  subscription_status text default 'trial' check (subscription_status in ('trial', 'active', 'past_due', 'suspended')),
  is_active boolean default true,
  allow_self_signup boolean default true,
  created_at timestamptz default now()
);

alter table clinics add column if not exists admin_email text;
alter table clinics add column if not exists subscription_status text default 'trial' check (subscription_status in ('trial', 'active', 'past_due', 'suspended'));
alter table clinics add column if not exists allow_self_signup boolean default true;

do $$
begin
  if exists (
    select 1
    from information_schema.constraint_column_usage
    where table_name = 'profiles' and constraint_name like '%role%'
  ) then
    alter table profiles drop constraint if exists profiles_role_check;
  end if;
end $$;

alter table profiles add constraint profiles_role_check check (role in ('afio_admin', 'hospital_admin', 'admin', 'doctor', 'assistant'));
update profiles set role = 'hospital_admin' where role = 'admin' and lower(email) <> 'raahymm@gmail.com';
update profiles set role = 'afio_admin', is_active = true where lower(email) = 'raahymm@gmail.com';

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  module_id text not null check (module_id in ('oct', 'vkg', 'corneal', 'retina')),
  name text not null,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique (clinic_id, module_id)
);

create table if not exists clinic_modules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  module_id text not null check (module_id in ('oct', 'vkg', 'corneal', 'retina')),
  is_enabled boolean default true,
  package_name text default 'demo',
  created_at timestamptz default now(),
  unique (clinic_id, module_id)
);

create table if not exists department_users (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references departments(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner', 'afio_admin', 'hospital_admin', 'admin', 'doctor', 'assistant', 'staff')),
  can_view_all boolean default false,
  created_at timestamptz default now(),
  unique (department_id, user_id)
);

alter table department_users drop constraint if exists department_users_role_check;
alter table department_users add constraint department_users_role_check check (role in ('owner', 'afio_admin', 'hospital_admin', 'admin', 'doctor', 'assistant', 'staff'));

create table if not exists module_api_keys (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  department_id uuid references departments(id) on delete cascade,
  module_id text not null check (module_id in ('oct', 'vkg', 'corneal', 'retina')),
  api_base_url text not null,
  api_key_secret_name text,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique (clinic_id, module_id)
);

alter table profiles add column if not exists clinic_id uuid references clinics(id);
alter table profiles add column if not exists default_department_id uuid references departments(id);
alter table patients add column if not exists clinic_id uuid references clinics(id);
alter table patients add column if not exists department_id uuid references departments(id);
alter table patients add column if not exists global_patient_key text;
alter table scans add column if not exists clinic_id uuid references clinics(id);
alter table scans add column if not exists department_id uuid references departments(id);
alter table scans add column if not exists module_id text check (module_id in ('oct', 'vkg', 'corneal', 'retina'));
alter table ai_results add column if not exists module_id text check (module_id in ('oct', 'vkg', 'corneal', 'retina'));
alter table reports add column if not exists clinic_id uuid references clinics(id);
alter table reports add column if not exists department_id uuid references departments(id);
alter table reports add column if not exists module_id text check (module_id in ('oct', 'vkg', 'corneal', 'retina'));
alter table if exists report_templates add column if not exists module_id text default 'oct' check (module_id in ('oct', 'vkg', 'corneal', 'retina'));
alter table if exists feedback_entries add column if not exists clinic_id uuid references clinics(id);
alter table if exists feedback_entries add column if not exists department_id uuid references departments(id);
alter table if exists feedback_entries add column if not exists module_id text check (module_id in ('oct', 'vkg', 'corneal', 'retina'));

insert into clinics (name, code)
values
  ('AFIO Demo Clinic', 'AFIO-DEMO'),
  ('Shifa', 'SHIFA'),
  ('Al Noor', 'ALNOOR')
on conflict (code) do update set name = excluded.name;

with demo_clinic as (
  select id from clinics where code = 'AFIO-DEMO'
)
insert into clinic_modules (clinic_id, module_id, is_enabled, package_name)
select id, module_id, true, 'group-1-demo'
from demo_clinic
cross join (values ('oct'), ('vkg')) as enabled(module_id)
on conflict (clinic_id, module_id) do nothing;

with shifa as (
  select id from clinics where code = 'SHIFA'
)
insert into clinic_modules (clinic_id, module_id, is_enabled, package_name)
select id, module_id, true, 'shifa-demo'
from shifa
cross join (values ('oct'), ('vkg'), ('corneal')) as enabled(module_id)
on conflict (clinic_id, module_id) do update set is_enabled = true;

with alnoor as (
  select id from clinics where code = 'ALNOOR'
)
insert into clinic_modules (clinic_id, module_id, is_enabled, package_name)
select id, module_id, true, 'trial'
from alnoor
cross join (values ('oct')) as enabled(module_id)
on conflict (clinic_id, module_id) do update set is_enabled = true;

with demo_clinic as (
  select id from clinics where code = 'AFIO-DEMO'
)
insert into departments (clinic_id, module_id, name)
select id, module_id, name
from demo_clinic
cross join (
  values
    ('oct', 'OCT Department'),
    ('vkg', 'VKG Department'),
    ('corneal', 'Corneal / Keratoconus Department'),
    ('retina', 'Retinal Fundus Department')
) as departments(module_id, name)
on conflict (clinic_id, module_id) do nothing;

update profiles
set clinic_id = (select id from clinics where code = 'AFIO-DEMO')
where clinic_id is null;

update profiles
set default_department_id = (
  select departments.id
  from departments
  join clinics on clinics.id = departments.clinic_id
  where clinics.code = 'AFIO-DEMO' and departments.module_id = 'oct'
)
where default_department_id is null;

update patients
set
  clinic_id = (select id from clinics where code = 'AFIO-DEMO'),
  department_id = (
    select departments.id
    from departments
    join clinics on clinics.id = departments.clinic_id
    where clinics.code = 'AFIO-DEMO' and departments.module_id = 'oct'
  ),
  global_patient_key = coalesce(nullif(regexp_replace(coalesce(cnic, ''), '\D', '', 'g'), ''), patient_code)
where clinic_id is null or department_id is null;

update scans
set
  clinic_id = patients.clinic_id,
  department_id = patients.department_id,
  module_id = 'oct'
from patients
where scans.patient_id = patients.id and (scans.clinic_id is null or scans.department_id is null or scans.module_id is null);

update reports
set
  clinic_id = patients.clinic_id,
  department_id = patients.department_id,
  module_id = 'oct'
from patients
where reports.patient_id = patients.id and (reports.clinic_id is null or reports.department_id is null or reports.module_id is null);

update ai_results
set module_id = 'oct'
where module_id is null;

do $$
begin
  if to_regclass('public.feedback_entries') is not null then
    update feedback_entries
    set
      clinic_id = (select id from clinics where code = 'AFIO-DEMO'),
      department_id = (
        select departments.id
        from departments
        join clinics on clinics.id = departments.clinic_id
        where clinics.code = 'AFIO-DEMO' and departments.module_id = 'oct'
      ),
      module_id = 'oct'
    where clinic_id is null or department_id is null or module_id is null;
  end if;
end $$;

insert into department_users (department_id, user_id, role, can_view_all)
select departments.id, profiles.id, profiles.role, profiles.role = 'admin'
from profiles
join departments on departments.clinic_id = profiles.clinic_id and departments.module_id = 'oct'
on conflict (department_id, user_id) do nothing;

create index if not exists idx_patients_department on patients(department_id);
create index if not exists idx_scans_department_module on scans(department_id, module_id);
create index if not exists idx_reports_department_module on reports(department_id, module_id);
create index if not exists idx_department_users_user on department_users(user_id);

do $$
begin
  if to_regclass('public.feedback_entries') is not null then
    execute 'create index if not exists idx_feedback_department_module on feedback_entries(department_id, module_id)';
  end if;
end $$;

alter table clinics enable row level security;
alter table departments enable row level security;
alter table clinic_modules enable row level security;
alter table department_users enable row level security;
alter table module_api_keys enable row level security;

drop policy if exists "authenticated read clinics" on clinics;
drop policy if exists "anon read signup clinics" on clinics;
drop policy if exists "authenticated read departments" on departments;
drop policy if exists "anon read enabled clinic modules" on clinic_modules;
drop policy if exists "authenticated read clinic modules" on clinic_modules;
drop policy if exists "authenticated read department users" on department_users;
drop policy if exists "authenticated read module api keys" on module_api_keys;

create policy "anon read signup clinics" on clinics for select to anon using (is_active = true and allow_self_signup = true and subscription_status <> 'suspended');
create policy "authenticated read clinics" on clinics for select to authenticated using (true);
create policy "authenticated read departments" on departments for select to authenticated using (true);
create policy "anon read enabled clinic modules" on clinic_modules for select to anon using (is_enabled = true);
create policy "authenticated read clinic modules" on clinic_modules for select to authenticated using (true);
create policy "authenticated read department users" on department_users for select to authenticated using (true);
create policy "authenticated read module api keys" on module_api_keys for select to authenticated using (true);
