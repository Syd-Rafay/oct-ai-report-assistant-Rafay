# AFIO Backup Runbook

Use this at the end of the day, after the last approved code change and after deploy.

## What it does

- Copies the current AFIO repo state into `AFIO_BACKUPS`.
- Names each snapshot with timestamp and git commit.
- Replaces `AFIO_BACKUPS\latest` with the newest snapshot.
- Removes the old `latest` copy so only the newest active snapshot stays there.
- Keeps a full snapshot history by timestamp folder.

## Where it saves

Default backup root:

```text
C:\Users\DELL\Documents\Personal folders\My shit\Internship AI\AFIO PROJECT\AFIO_BACKUPS
```

Inside it:

```text
AFIO_BACKUPS\YYYY-MM-DD_HHMMSS_<commit>\
AFIO_BACKUPS\latest\
AFIO_BACKUPS\snapshot-log.tsv
```

## What is included

- Source code
- Pages, components, libs, backend code
- Supabase SQL files
- Config files
- Documentation and handovers

## What is excluded

- `.git`
- `.next`
- `node_modules`
- build outputs
- logs
- `*.tsbuildinfo`
- Python cache files

## Command

From the repo root:

```powershell
pnpm snapshot:afio
```

If you need to run it directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/save-afio-snapshot.ps1
```

## Nightly workflow

1. Finish today’s code.
2. Commit and push to `main`.
3. Redeploy Vercel/Render if needed.
4. Run `pnpm snapshot:afio`.
5. Confirm `AFIO_BACKUPS\latest` exists and matches the new commit.

## Rule

Keep the backup snapshot synchronized with the latest approved production-ready code. When a new snapshot is made, the `latest` folder should be replaced with the new version.
