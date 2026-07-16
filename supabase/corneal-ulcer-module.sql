alter table departments drop constraint if exists departments_module_id_check;
alter table departments add constraint departments_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table clinic_modules drop constraint if exists clinic_modules_module_id_check;
alter table clinic_modules add constraint clinic_modules_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table patients drop constraint if exists patients_module_id_check;
alter table patients add constraint patients_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table scans drop constraint if exists scans_module_id_check;
alter table scans add constraint scans_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table ai_results drop constraint if exists ai_results_module_id_check;
alter table ai_results add constraint ai_results_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table reports drop constraint if exists reports_module_id_check;
alter table reports add constraint reports_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table if exists report_templates drop constraint if exists report_templates_module_id_check;
alter table if exists report_templates add constraint report_templates_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table if exists report_templates drop constraint if exists report_templates_disease_class_check;
alter table if exists report_templates add constraint report_templates_disease_class_check
check (disease_class in (
  'CNV',
  'DME',
  'DRUSEN',
  'NORMAL',
  'KCN',
  'SUSPECT',
  'FLAKY_MIXED',
  'POINTLIKE',
  'NO_DR',
  'MILD_DR',
  'MODERATE_DR',
  'SEVERE_DR',
  'PROLIFERATIVE_DR'
));

alter table if exists feedback_entries drop constraint if exists feedback_entries_module_id_check;
alter table if exists feedback_entries add constraint feedback_entries_module_id_check
check (module_id in ('oct', 'vkg', 'corneal', 'corneal_ulcer', 'retina'));

alter table ai_results drop constraint if exists ai_results_predicted_class_check;
alter table ai_results add constraint ai_results_predicted_class_check
check (predicted_class in (
  'CNV',
  'DME',
  'DRUSEN',
  'NORMAL',
  'KCN',
  'SUSPECT',
  'FLAKY_MIXED',
  'POINTLIKE',
  'NO_DR',
  'MILD_DR',
  'MODERATE_DR',
  'SEVERE_DR',
  'PROLIFERATIVE_DR'
));

insert into departments (clinic_id, module_id, name)
select clinics.id, 'corneal_ulcer', 'Corneal Ulcer Department'
from clinics
on conflict (clinic_id, module_id) do nothing;

insert into report_templates (module_id, disease_class, findings, impression, recommendation)
values
  (
    'corneal_ulcer',
    'FLAKY_MIXED',
    'The slit-lamp corneal image shows screening features consistent with a flaky or mixed corneal surface ulcer pattern.',
    'Corneal ulcer screening suggests a Flaky/Mixed pattern. This is a preliminary image-based result and requires slit-lamp clinical confirmation.',
    'Corneal specialist or ophthalmologist review is advised. Correlate with symptoms, fluorescein staining, infection risk, culture status, and treatment history.'
  ),
  (
    'corneal_ulcer',
    'POINTLIKE',
    'The slit-lamp corneal image shows screening features consistent with a point-like corneal ulcer pattern.',
    'Corneal ulcer screening suggests a Point-like pattern. This is a preliminary image-based result and requires clinical confirmation.',
    'Review with slit-lamp examination, fluorescein staining, pain/redness history, infectious risk factors, and follow-up response to therapy.'
  )
on conflict (module_id, disease_class) do update
set findings = excluded.findings,
    impression = excluded.impression,
    recommendation = excluded.recommendation,
    updated_at = now();
