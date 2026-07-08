import { clsx } from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ReportStatus } from "@/lib/types";

export function Button({
  children,
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={clsx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-clinic-600 text-white shadow-soft hover:bg-clinic-700",
        variant === "secondary" && "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={clsx("rounded-lg border border-slate-200 bg-white shadow-panel", className)}>{children}</section>;
}

export function CardHeader({
  title,
  subtitle,
  action
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-base font-bold text-slate-950">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ status }: { status: ReportStatus | "demo" | "active" | "pending" | "suspended" }) {
  const classes = {
    draft: "bg-slate-100 text-slate-700",
    pending_review: "bg-amber-100 text-amber-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-red-100 text-red-800",
    superseded: "bg-slate-200 text-slate-700",
    demo: "bg-blue-100 text-blue-800",
    active: "bg-teal-100 text-teal-800",
    pending: "bg-amber-100 text-amber-800",
    suspended: "bg-red-100 text-red-800"
  }[status];
  const label =
    status === "pending_review"
      ? "Pending Review"
      : status === "superseded"
        ? "Superseded"
      : status === "pending"
        ? "Pending Approval"
        : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={clsx("inline-flex rounded-full px-2.5 py-1 text-xs font-bold", classes)}>{label}</span>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-5 py-8 text-center">
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
    </div>
  );
}

export function SafetyNotice() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
      AI-assisted preliminary result. Requires doctor review.
    </div>
  );
}
