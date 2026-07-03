# Deployment

## What Goes Where

Deploy the Next.js frontend to Vercel.

Deploy the FastAPI PyTorch backend somewhere that supports long-running Python servers and model files, such as Render or Railway. Vercel is not the right place for the `.pth` model backend.

## Vercel Frontend

1. Push this project folder to GitHub.
2. Create a new Vercel project from that GitHub repo.
3. Add these Vercel environment variables:

```text
NEXT_PUBLIC_SUPABASE_URL=https://vxivcawwlxcrnkofbywg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your Supabase anon public key
NEXT_PUBLIC_AI_BACKEND_URL=https://your deployed FastAPI backend URL
```

4. Deploy.

## Supabase Auth URLs

In Supabase, open:

```text
Authentication > URL Configuration
```

Set:

```text
Site URL = https://your-vercel-app.vercel.app
```

Add redirect URLs:

```text
http://127.0.0.1:3000/**
https://your-vercel-app.vercel.app/**
```

## Supabase SQL

Run both files in Supabase SQL Editor:

```text
supabase/schema.sql
supabase/finish-setup.sql
```

## Backend Environment

For the backend host, upload/copy:

```text
oct-ai-backend/main.py
oct-ai-backend/requirements.txt
oct-ai-backend/best_oct_model_b3.pth
```

Start command:

```text
uvicorn main:app --host 0.0.0.0 --port $PORT
```

Environment variable:

```text
ALLOWED_ORIGINS=https://your-vercel-app.vercel.app
```

For public patient report lookup and automatic access emails, also add:

```text
SUPABASE_URL=https://vxivcawwlxcrnkofbywg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your Supabase service role key
FRONTEND_URL=https://oct-ai-report-assistant.vercel.app
SMTP_HOST=your SMTP host
SMTP_PORT=587
SMTP_USERNAME=your SMTP username
SMTP_PASSWORD=your SMTP password
SMTP_FROM_EMAIL=reports@your-clinic-domain.com
SMTP_FROM_NAME=OCT AI Report Assistant
```

The service role key must stay on the backend only. Do not add it to Vercel `NEXT_PUBLIC_*` variables.

After the backend is deployed, set `NEXT_PUBLIC_AI_BACKEND_URL` in Vercel to that deployed backend URL.
