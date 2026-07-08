create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key references auth.users(id),
  full_name text not null,
  email text not null,
  role text not null check (role in ('admin', 'doctor', 'assistant')),
  doctor_id text unique,
  specialization text,
  clinic_name text,
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  patient_code text unique not null,
  cnic text unique,
  access_password text,
  full_name text not null,
  age int not null,
  gender text not null,
  phone text,
  email text,
  address text,
  diabetes_history text default 'Unknown',
  previous_eye_disease text,
  clinical_notes text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  image_url text not null,
  storage_path text not null,
  scan_type text default 'OCT',
  eye_side text check (eye_side in ('Left', 'Right', 'Both', 'Unknown')),
  scan_notes text,
  uploaded_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table if not exists ai_results (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid references scans(id) on delete cascade,
  predicted_class text not null check (predicted_class in ('CNV', 'DME', 'DRUSEN', 'NORMAL')),
  confidence numeric not null,
  probabilities jsonb not null,
  model_name text,
  model_version text,
  heatmap_url text,
  is_dummy_result boolean default false,
  created_at timestamptz default now()
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  scan_id uuid references scans(id) on delete cascade,
  ai_result_id uuid references ai_results(id),
  findings text,
  impression text,
  recommendation text,
  doctor_notes text,
  final_diagnosis text,
    status text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'rejected', 'superseded')),
  approved_by uuid references profiles(id),
  pdf_url text,
  pdf_storage_path text,
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  approved_at timestamptz
);

create table if not exists report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete cascade,
  version_number int not null,
  findings text,
  impression text,
  recommendation text,
  doctor_notes text,
  final_diagnosis text,
  edited_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  action text not null,
  record_type text,
  record_id uuid,
  details jsonb,
  created_at timestamptz default now()
);

alter table profiles enable row level security;
alter table patients enable row level security;
alter table scans enable row level security;
alter table ai_results enable row level security;
alter table reports enable row level security;
alter table report_versions enable row level security;
alter table audit_logs enable row level security;

create policy "authenticated read profiles" on profiles for select to authenticated using (true);
create policy "authenticated read patients" on patients for select to authenticated using (true);
create policy "authenticated insert patients" on patients for insert to authenticated with check (true);
create policy "authenticated update patients" on patients for update to authenticated using (true) with check (true);
create policy "authenticated delete patients" on patients for delete to authenticated using (true);
create policy "authenticated read scans" on scans for select to authenticated using (true);
create policy "authenticated insert scans" on scans for insert to authenticated with check (true);
create policy "authenticated read ai results" on ai_results for select to authenticated using (true);
create policy "authenticated insert ai results" on ai_results for insert to authenticated with check (true);
create policy "authenticated read reports" on reports for select to authenticated using (true);
create policy "authenticated write reports" on reports for all to authenticated using (true) with check (true);
create policy "authenticated read report versions" on report_versions for select to authenticated using (true);
create policy "authenticated insert report versions" on report_versions for insert to authenticated with check (true);
create policy "authenticated read audit logs" on audit_logs for select to authenticated using (true);
create policy "authenticated insert audit logs" on audit_logs for insert to authenticated with check (true);
