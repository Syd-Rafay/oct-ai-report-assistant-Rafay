"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { clsx } from "clsx";
import {
  ClipboardList,
  FileClock,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Search,
  ShieldCheck,
  Upload,
  UserCog,
  UserPlus
} from "lucide-react";
import type { ReactNode } from "react";
import { useDemoStore } from "@/lib/demo-store";
import { Button } from "./ui";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/patients/new", label: "New Patient", icon: UserPlus },
  { href: "/patients/search", label: "Search Patient", icon: Search },
  { href: "/scans/upload", label: "Upload Scan", icon: Upload },
  { href: "/reports/history", label: "Report History", icon: FileClock },
  { href: "/change-password", label: "Change Password", icon: KeyRound }
];

const doctorItems = [
  { href: "/admin/templates", label: "Templates", icon: ClipboardList }
];

const adminItems = [
  { href: "/admin/users", label: "Admin Users", icon: UserCog },
  { href: "/admin/templates", label: "Templates", icon: ClipboardList },
  { href: "/admin/feedback", label: "Feedback Inbox", icon: Inbox },
  { href: "/admin/audit-logs", label: "Login & Audit History", icon: ShieldCheck }
];

function EyeDepartmentLogo() {
  return (
    <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-md bg-clinic-600 text-white shadow-soft">
      <svg viewBox="0 0 44 44" aria-hidden="true" className="h-9 w-9">
        <path
          d="M5.5 22c4.2-7.1 9.8-10.7 16.5-10.7S34.3 14.9 38.5 22C34.3 29.1 28.7 32.7 22 32.7S9.7 29.1 5.5 22Z"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <circle cx="22" cy="22" r="7.6" fill="#ecfeff" opacity="0.98" />
        <circle cx="22" cy="22" r="4.8" fill="#67e8f9" opacity="0.95" />
        <circle cx="22" cy="22" r="2.2" fill="#0e7490" opacity="0.9" />
        <circle cx="20.4" cy="20.2" r="1.1" fill="#ffffff" opacity="0.9" />
      </svg>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const store = useDemoStore();
  const isAuthenticated = Boolean(store.data.currentUserId);

  useEffect(() => {
    if (store.ready && !isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [store.ready, isAuthenticated, pathname, router]);

  if (!store.ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm font-semibold text-slate-600 shadow-panel">
          Loading secure workspace...
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm font-semibold text-slate-600 shadow-panel">
          Redirecting to sign in...
        </div>
      </main>
    );
  }

  const items = store.currentUser.role === "admin" ? [...navItems, ...adminItems] : store.currentUser.role === "doctor" ? [...navItems, ...doctorItems] : navItems;

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 overflow-y-auto border-r border-slate-200 bg-white lg:block">
        <div className="flex h-20 items-center gap-3 border-b border-slate-100 px-6">
          <EyeDepartmentLogo />
          <div>
            <p className="text-sm font-black text-slate-950">OCT AI Report</p>
            <p className="text-xs font-medium text-slate-500">Clinical Assistant</p>
          </div>
        </div>
        <nav className="space-y-1 p-4 pb-32">
          {items.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-semibold transition",
                  active ? "bg-clinic-50 text-clinic-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                )}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="fixed bottom-0 left-0 w-72 border-t border-slate-100 bg-white p-4">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="text-sm font-bold text-slate-900">{store.currentUser.fullName}</p>
            <p className="text-xs text-slate-500">{store.currentUser.role.toUpperCase()}</p>
          </div>
        </div>
      </aside>
      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">Clinical workspace</p>
              <h1 className="text-xl font-black text-slate-950">OCT AI Report Assistant</h1>
            </div>
            <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
              <select
                className="field min-h-10 w-full py-2 text-sm font-semibold md:w-56 lg:hidden"
                value={items.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)) ? items.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href : "/dashboard"}
                onChange={(event) => router.push(event.target.value)}
                aria-label="Navigate workspace"
              >
                {items.map((item) => (
                  <option key={item.href} value={item.href}>
                    {item.label}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                onClick={async () => {
                  await store.logout();
                  router.push("/login");
                }}
              >
                <LogOut size={16} />
                Logout
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-3 py-5 sm:px-4 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageTitle({
  title,
  subtitle,
  action
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-2xl font-black tracking-tight text-slate-950">{title}</h2>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {action ? <div className="w-full sm:w-auto">{action}</div> : null}
    </div>
  );
}
