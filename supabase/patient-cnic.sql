alter table patients
add column if not exists cnic text;

alter table patients
add column if not exists access_password text;

create unique index if not exists patients_cnic_unique
on patients (cnic)
where cnic is not null and cnic <> '';
