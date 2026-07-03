import Link from "next/link";
import { PatientReportCheckView } from "@/components/views";

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">OCT AI Report Assistant</p>
            <h1 className="text-2xl font-black text-slate-950">Patient report access</h1>
          </div>
          <Link href="/login" className="text-sm font-bold text-clinic-700">
            Clinical staff login
          </Link>
        </div>
        <PatientReportCheckView />
      </div>
    </main>
  );
}
