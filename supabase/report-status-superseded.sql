alter table reports
drop constraint if exists reports_status_check;

alter table reports
add constraint reports_status_check
check (status in ('draft', 'pending_review', 'approved', 'rejected', 'superseded'));
