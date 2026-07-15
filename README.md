# AFIO Clinical Report Platform

AFIO is a multi-hospital ophthalmology workflow platform for patient records, scan uploads, AI screening, doctor review, approved reports, patient report access, feedback, and business-level hospital/module management.

Production site: `https://cvclinics.online`

GitHub repo: `https://github.com/Raahym/oct-ai-report-assistant`

## What The Platform Does

- Supports multiple hospitals with separated patients, scans, reports, users, feedback, and audit logs.
- Lets AFIO Business Admin create hospitals, assign enabled modules, invite AFIO business members, and manage subscriptions/access.
- Lets hospital admins approve/reject staff signups, suspend/delete users, and control hospital staff roles.
- Lets doctors/clinical staff create patients, upload scans, run screening, generate report drafts, review/edit reports, approve reports, print/download reports, and share patient access credentials.
- Lets patients check approved reports through the public report lookup flow.

## Clinical Modules

- `OCT`: OCT image screening with OCT report workflow and Grad-CAM support.
- `VKG`: corneal/topography keratoconus workflow, currently binary output: `Keratoconus` / `Non-keratoconus`.
- `Retinal Screening`: fundus workflow for diabetic retinopathy, glaucoma risk, and hypertensive retinopathy.
- `Corneal Detection`: separate corneal model backend services defined in Render.

Each module has separate module-aware patients, scan uploads, report history, report templates, and report text. Module routes use `?module=oct`, `?module=vkg`, `?module=retina`, or `?module=corneal`.

## Tech Stack

- Frontend: Next.js App Router, React, TypeScript, Tailwind CSS.
- Database/auth/storage: Supabase.
- PDF/report generation: browser-side report generation with `jspdf`.
- Email: Resend when configured.
- Frontend hosting: Vercel.
- Model/service hosting: Render for Git-backed services; AWS for separately created Grad-CAM/model workers where used.

## Main Folders

```text
src/app/                  Next.js pages and API routes
src/components/           App shell and major UI views
src/lib/                  Store, types, API clients, PDF/report helpers
supabase/                 SQL schema and setup files
oct-ai-backend/           OCT FastAPI backend and Grad-CAM service code
corneal-ai-backend/       Corneal/VKG backend services
retina-ai-backend/        Retinal screening backend services
render.yaml               Render blueprint/service definitions
DEPLOYMENT.md             Deployment environment notes
AFIO_BACKUP_RUNBOOK.md    Backup/restore notes
```

## Local Development

Install dependencies:

```bash
pnpm install
```

Run the frontend:

```bash
pnpm dev
```

Open:

```text
http://127.0.0.1:3000/login
```

Type check:

```bash
pnpm run typecheck
```

Create a local AFIO snapshot:

```bash
pnpm run snapshot:afio
```

## Required Environment Variables

Use `.env.example`, `.env.production.example`, and `DEPLOYMENT.md` as references. Do not commit real secrets.

Important frontend/server variables:

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

`SUPABASE_SERVICE_ROLE_KEY` must stay server-side only. Never expose it as a `NEXT_PUBLIC_*` variable.

## Deployment Summary

- GitHub `main` is the source branch.
- Vercel should auto-deploy frontend changes from GitHub.
- Render services are defined in `render.yaml`; auto-deploy must be checked per Render service in the Render dashboard.
- Supabase SQL changes must be applied manually unless a migration/CI process is added.
- AWS workers do not automatically update from GitHub unless a separate CI/CD process is configured.

## Current Render Services In `render.yaml`

- `oct-ai-backend`
- `afio-oct-gradcam-backend`
- `afio-corneal-ai-backend`
- `afio-corneal-resnet-backend`
- `afio-corneal-densenet-backend`
- `afio-corneal-efficientnet-backend`
- `afio-retina-ai-backend`
- `afio-retina-dr-backend`
- `afio-retina-glaucoma-backend`
- `afio-retina-hr-backend`

## Backup And Restore

The latest local emergency restore backup is stored outside the repo at:

```text
C:\Users\DELL\Documents\Personal folders\My shit\Internship AI\AFIO PROJECT\AFIO_BACKUPS\latest
```

It contains:

- source mirror
- full Git bundle
- local env backup folder
- Supabase live JSON export
- platform inventory
- restore instructions

See `PROJECT_OPERATOR_GUIDE.md` for the detailed handover and restore guide.

## Medical Safety

Screening output is decision support only. Draft reports can mention automated screening internally, but approved reports must be doctor-reviewed and should not present AI output as a standalone diagnosis.
