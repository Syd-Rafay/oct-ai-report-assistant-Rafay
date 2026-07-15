# AFIO Project Operator Guide

This file explains what the project is, what each platform does, where the code lives, and how someone can navigate, deploy, or restore the system even if they are not familiar with Vercel, Render, AWS, or Supabase.

Do not paste secrets into chat or commit them to GitHub. Real keys are stored in platform dashboards and in local backup folders marked `secrets_local_do_not_share`.

## 1. Project In One Line

AFIO is a multi-hospital ophthalmology workflow system that keeps hospital data separated while running OCT, VKG/corneal, and retinal screening workflows through doctor-reviewed report generation.

## 2. Live User-Facing Site

```text
https://cvclinics.online
```

This is the main app hospitals use.

## 3. GitHub

Repo:

```text
https://github.com/Raahym/oct-ai-report-assistant
```

Branch normally used:

```text
main
```

If a teammate pushes frontend code to `main`, Vercel should normally rebuild and update the website automatically.

Important: GitHub pushes do not automatically apply Supabase SQL or AWS worker changes.

## 4. Main App Navigation

### Public Pages

- `/login`: sign in and request account access.
- `/forgot-password`: send reset email.
- `/reset-password`: set new password after reset email.
- `/reports/check`: patient/public approved report lookup.

### Hospital Workspace

Hospital users see only their hospital.

- `AFIO Dashboard`: module overview for the current hospital.
- `OCT`: OCT module section.
- `VKG`: VKG/topography module section.
- `Retinal Screening`: fundus screening section.
- `Change Password`: internal user password update.
- `Admin Users`: approve/reject/suspend/delete hospital staff.
- `Feedback Inbox`: review feedback/complaints.
- `Login & Audit History`: audit log view.

### Business Workspace

AFIO business users are not supposed to enter clinical module pages directly.

- `Hospital Preview`: high-level preview only.
- `Business Admin`: create/edit/suspend/delete hospitals and enable modules.
- `AFIO Members`: invite/manage AFIO business team members and permissions.
- `Change Password`.

## 5. Hospital And User System

### Hospital Creation

AFIO Business Admin creates hospitals from the Business Admin page.

Provisioning creates:

- clinic/hospital row
- departments
- enabled modules
- hospital admin auth user/profile
- module access rows

Required server secret:

```text
SUPABASE_SERVICE_ROLE_KEY
```

If this is missing in Vercel, hospital provisioning and user admin actions will fail.

### User Signup

New staff can request access on `/login` by switching to Create account.

The signup creates:

- Supabase auth user
- pending `profiles` row
- hospital assignment

Hospital admins then approve/reject them from `Admin Users`.

If email confirmation is enabled in Supabase, users may need to confirm their email before logging in, but the pending request should still appear for admins.

## 6. Clinical Modules

### OCT

Purpose:

- OCT patient workflow
- OCT image upload
- OCT prediction
- OCT Grad-CAM heatmap support
- doctor report review and approval

Frontend module routes:

```text
/modules/oct
/patients/new?module=oct
/patients/search?module=oct
/scans/upload?module=oct
/reports/history?module=oct
/admin/templates?module=oct
```

Backend/service:

- `oct-ai-backend`
- `afio-oct-gradcam-backend`

### VKG / Corneal

Purpose:

- corneal/topography workflow
- keratoconus screening
- binary report output: keratoconus or non-keratoconus

Frontend routes:

```text
/modules/vkg
/patients/new?module=vkg
/patients/search?module=vkg
/scans/upload?module=vkg
/reports/history?module=vkg
/admin/templates?module=vkg
```

Backend/service folders:

```text
corneal-ai-backend/
```

Render services include:

- `afio-corneal-ai-backend`
- `afio-corneal-resnet-backend`
- `afio-corneal-densenet-backend`
- `afio-corneal-efficientnet-backend`

### Retinal Screening

Purpose:

- fundus image workflow
- diabetic retinopathy
- glaucoma risk
- hypertensive retinopathy
- combined Retina report draft

Frontend routes:

```text
/modules/retina
/patients/new?module=retina
/patients/search?module=retina
/scans/upload?module=retina
/reports/history?module=retina
/admin/templates?module=retina
```

Backend/service folder:

```text
retina-ai-backend/
```

Render services:

- `afio-retina-dr-backend`
- `afio-retina-glaucoma-backend`
- `afio-retina-hr-backend`
- `afio-retina-ai-backend` as legacy/combined fallback

## 7. Vercel

Vercel hosts the Next.js website.

What Vercel needs:

- GitHub repo connected.
- Production branch set to `main`.
- Environment variables configured.
- Domain `cvclinics.online` connected.

Common Vercel variables:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_AI_BACKEND_URL
NEXT_PUBLIC_OCT_GRADCAM_BACKEND_URL
NEXT_PUBLIC_CORNEAL_BACKEND_URL
NEXT_PUBLIC_RETINA_BACKEND_URL
NEXT_PUBLIC_RETINA_DR_BACKEND_URL
NEXT_PUBLIC_RETINA_GLAUCOMA_BACKEND_URL
NEXT_PUBLIC_RETINA_HR_BACKEND_URL
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
EMAIL_FROM
```

After changing any Vercel env var, redeploy the site.

## 8. Render

Render hosts Git-backed backend/model services defined in:

```text
render.yaml
```

Render service names:

```text
oct-ai-backend
afio-oct-gradcam-backend
afio-corneal-ai-backend
afio-corneal-resnet-backend
afio-corneal-densenet-backend
afio-corneal-efficientnet-backend
afio-retina-ai-backend
afio-retina-dr-backend
afio-retina-glaucoma-backend
afio-retina-hr-backend
```

How to check auto-deploy:

1. Open Render dashboard.
2. Open a service.
3. Go to Settings.
4. Check Auto-Deploy.
5. If Auto-Deploy is On, GitHub pushes to the connected branch redeploy that service.

If a service is not connected to the GitHub repo or Auto-Deploy is Off, redeploy manually.

## 9. AWS

AWS has been used for separate heavy workers, especially Grad-CAM/model-worker style deployments.

Important:

- AWS workers do not update automatically from GitHub unless a CI/CD pipeline is created.
- If AWS is lost, recreate the worker using the latest handover/bootstrap notes and current code.
- Keep workers separate from each other so one expensive/heavy service does not overload another.
- Avoid Elastic IP/load balancer/GPU unless truly needed, to protect credits.

## 10. Supabase

Supabase handles:

- Auth users
- profiles
- hospitals/clinics
- departments and department users
- patients
- scans
- AI results
- reports
- feedback
- audit logs
- storage buckets

Important tables:

```text
clinics
clinic_modules
departments
department_users
profiles
patients
scans
ai_results
reports
feedback_entries
feedback_messages
audit_logs
report_templates
```

Important SQL folder:

```text
supabase/
```

If rebuilding Supabase:

1. Create a new Supabase project.
2. Run SQL files from `supabase/`.
3. Recreate storage buckets if needed.
4. Configure Auth URL settings.
5. Add new Supabase URL/keys to Vercel and Render.

Supabase passwords cannot be exported. Users may need reset-password emails after full disaster recovery.

## 11. Email

Email is used for:

- hospital onboarding/login credentials
- report access emails
- feedback replies
- password resets through Supabase

Primary app email provider:

```text
RESEND_API_KEY
EMAIL_FROM
```

Password reset emails are controlled by Supabase Auth settings and redirect URLs.

## 12. Environment Rules

Public keys may start with:

```text
NEXT_PUBLIC_
```

Secrets must never start with `NEXT_PUBLIC_`.

Never expose:

```text
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
SMTP_PASSWORD
AWS keys
```

## 13. Local Backup System

Latest local backup:

```text
C:\Users\DELL\Documents\Personal folders\My shit\Internship AI\AFIO PROJECT\AFIO_BACKUPS\latest
```

Backup contents:

```text
source_mirror/
afio-project-full.git.bundle
secrets_local_do_not_share/
supabase_live_export_local_do_not_share/
RESTORE_README.txt
PLATFORM_INVENTORY.txt
git-status.txt
git-log-last-80.txt
git-remotes.txt
git-commit-head.txt
```

The zip snapshot is also saved in:

```text
C:\Users\DELL\Documents\Personal folders\My shit\Internship AI\AFIO PROJECT\AFIO_BACKUPS\snapshot_2026-07-15_20-43-23
```

## 14. Fast Restore Checklist

1. Copy `source_mirror` from `AFIO_BACKUPS/latest` to a clean folder.
2. Run `pnpm install`.
3. Push the restored code to GitHub or clone from `afio-project-full.git.bundle`.
4. Connect Vercel to the restored GitHub repo.
5. Add Vercel env vars from the local secret backup and deployment docs.
6. Deploy Vercel.
7. Recreate Render services from `render.yaml`.
8. Add required Render env vars.
9. Recreate Supabase from SQL files and live JSON export if needed.
10. Recreate AWS workers manually from handover/bootstrap notes if they were lost.
11. Test login, hospital admin, signup approval, OCT upload, VKG upload, Retina upload, report generation, report PDF, public report check, feedback, and password reset.

## 15. Common Problems

### New users do not appear in Admin Users

Check:

- Was the signup profile created in `profiles`?
- Is `SUPABASE_SERVICE_ROLE_KEY` present in Vercel?
- Is the latest code deployed?
- Is the admin looking at the right hospital?

### Hospital provisioning fails

Check:

- `SUPABASE_SERVICE_ROLE_KEY`
- Supabase URL/anon key
- Vercel redeployed after env changes

### Grad-CAM missing from reports

Old reports do not magically get heatmaps. Re-run analysis for the scan after backend Grad-CAM is working.

Check:

- `NEXT_PUBLIC_OCT_GRADCAM_BACKEND_URL`
- Grad-CAM worker health
- report generated after heatmap URL exists

### VKG page shows OCT wording

Check that URLs include:

```text
?module=vkg
```

Patient profile now infers module from patient/scans when URL module is missing, but links should still preserve module.

### Render did not update after GitHub push

Check Render service Settings > Auto-Deploy.

### Vercel did not update after GitHub push

Check Vercel deployments tab and build logs.

## 16. Verification Before Demo Or Handover

Run:

```bash
pnpm run typecheck
```

Manual smoke test:

1. Sign in as AFIO Business Admin.
2. Open Business Admin and confirm hospital list/modules.
3. Sign in as hospital admin.
4. Confirm only own hospital staff appear.
5. Create a pending signup and approve/reject it.
6. Create OCT patient and upload OCT.
7. Create VKG patient and upload VKG.
8. Create Retina patient and upload fundus.
9. Generate, approve, view, print/download report.
10. Check public report lookup.
11. Submit feedback and view Feedback Inbox.
12. Test Forgot Password.

## 17. What Not To Do

- Do not commit `.env.local`.
- Do not expose service role keys in chat.
- Do not mix OCT/VKG/Retina patient routes without module query.
- Do not put heavy Grad-CAM workers inside the same free/low-resource service as critical screening APIs.
- Do not delete hospitals/users without checking whether real demo data must be preserved.
