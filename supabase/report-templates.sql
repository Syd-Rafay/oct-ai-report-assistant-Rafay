create table if not exists report_templates (
  module_id text not null default 'oct' check (module_id in ('oct', 'vkg', 'corneal', 'retina')),
  disease_class text not null check (disease_class in ('CNV', 'DME', 'DRUSEN', 'NORMAL', 'KCN', 'SUSPECT')),
  findings text not null default '',
  impression text not null default '',
  recommendation text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  unique (module_id, disease_class)
);

alter table report_templates enable row level security;

drop policy if exists "authenticated read report templates" on report_templates;
create policy "authenticated read report templates"
on report_templates for select to authenticated
using (true);

drop policy if exists "authenticated write report templates" on report_templates;
create policy "authenticated write report templates"
on report_templates for all to authenticated
using (true)
with check (true);
