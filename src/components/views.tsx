"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  Edit3,
  Eye,
  FileText,
  Inbox,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload,
  Wand2
} from "lucide-react";
import { PageTitle } from "./app-shell";
import { Button, Card, CardHeader, EmptyState, SafetyNotice, StatusBadge } from "./ui";
import { predictOCT } from "@/lib/ai-api";
import { useDemoStore } from "@/lib/demo-store";
import { addFeedbackResponse, getCachedFeedbackEntries, getFeedbackEntries, submitFeedback, updateFeedbackStatus } from "@/lib/feedback";
import { prepareScanImages } from "@/lib/image-processing";
import { downloadPublicReportPdf, downloadReportPdf } from "@/lib/pdf";
import { changePatientAccessPassword, checkPublicReport, getPatientAccessId, getPatientCurrentAccessPassword, sendFeedbackEmail, sendReportAccessEmail, type PublicReport, type PublicReportResult } from "@/lib/report-access";
import { getReportTemplates, reportTemplates, saveReportTemplates } from "@/lib/report-templates";
import type { DiseaseClass, EyeSide, FeedbackEntry, Gender, Patient, Report, Role, Scan } from "@/lib/types";

const diseaseClasses: DiseaseClass[] = ["CNV", "DME", "DRUSEN", "NORMAL"];

const MIN_PATIENT_AGE = 0;
const MAX_PATIENT_AGE = 130;

function isValidPatientAge(value: string) {
  if (value.trim() === "") return false;
  const age = Number(value);
  return Number.isInteger(age) && age >= MIN_PATIENT_AGE && age <= MAX_PATIENT_AGE;
}

function cleanAgeInput(value: string) {
  if (value === "") return "";
  const numeric = value.replace(/[^\d]/g, "");
  if (!numeric) return "";
  return String(Math.min(MAX_PATIENT_AGE, Number(numeric)));
}

function cnicDigits(value: string) {
  return value.replace(/\D/g, "").slice(0, 13);
}

function formatCnic(value: string) {
  const digits = cnicDigits(value);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

function isValidCnic(value: string) {
  return cnicDigits(value).length === 13;
}

function cleanAccessIdInput(value: string) {
  return /^\d|[-\d]+$/.test(value) ? cnicDigits(value) : value.trim();
}

async function downloadImage(url: string, filename: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function ScanImageActions({
  scan,
  patientCode,
  canManage,
  onChangePhoto,
  onDeleteScan,
  busy = false
}: {
  scan: Scan;
  patientCode?: string;
  canManage: boolean;
  onChangePhoto?: (file: File) => void | Promise<void>;
  onDeleteScan?: () => void | Promise<void>;
  busy?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
      <a href={scan.imageUrl} target="_blank" rel="noreferrer" className="block">
        <Button className="w-full sm:w-auto" variant="secondary">
          <Eye size={16} />
          View Original
        </Button>
      </a>
      <Button className="w-full sm:w-auto" variant="secondary" onClick={() => void downloadImage(scan.imageUrl, `OCT_${patientCode ?? scan.id}.jpg`)}>
        <Download size={16} />
        Download Image
      </Button>
      {canManage && onChangePhoto ? (
        <>
          <input
            ref={fileRef}
            className="hidden"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onChangePhoto(file);
            }}
          />
          <Button className="w-full sm:w-auto" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
            Change Photo
          </Button>
        </>
      ) : null}
      {canManage && onDeleteScan ? (
        <Button className="w-full sm:w-auto" variant="danger" disabled={busy} onClick={() => void onDeleteScan()}>
          <Trash2 size={16} />
          Delete Scan
        </Button>
      ) : null}
    </div>
  );
}

function doctorDisplayName(name?: string) {
  if (!name) return "Doctor";
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

function patientSafeReportText(value: string) {
  return value
    .replace(/AI-assisted classification suggests/gi, "Doctor-reviewed results show")
    .replace(/based on AI-assisted analysis/gi, "after doctor review")
    .replace(/AI-assisted/g, "Doctor-reviewed")
    .replace(/\bAI\b/g, "doctor-reviewed analysis");
}

function patientResult(result?: string, fallback?: string) {
  return result && result !== "Needs clinical correlation" ? result : fallback && fallback !== "Needs clinical correlation" ? fallback : "-";
}

function toPublicReport(report: Report, patient: Patient, aiResult?: { predictedClass?: string }, approverName?: string): PublicReport {
  const result = patientResult(report.finalDiagnosis, aiResult?.predictedClass);
  return {
    id: report.id,
    patientCode: getPatientAccessId(patient),
    patientName: patient.fullName,
    age: patient.age,
    gender: patient.gender,
    result,
    findings: patientSafeReportText(report.findings),
    impression: patientSafeReportText(report.impression),
    recommendation: patientSafeReportText(report.recommendation),
    doctorNotes: patientSafeReportText(report.doctorNotes || "No additional notes."),
    finalDiagnosis: result,
    approvedByName: doctorDisplayName(approverName),
    approvedAt: report.approvedAt,
    createdAt: report.createdAt,
    status: report.status
  };
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value.trim());
}

export function LoginView() {
  const router = useRouter();
  const store = useDemoStore();
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [requestedRole, setRequestedRole] = useState<Role>("doctor");
  const [department, setDepartment] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    setMessage("");
    if (!isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      if (authMode === "signup") {
        await store.signUp({
          email,
          password,
          fullName: fullName || email.split("@")[0],
          role: requestedRole,
          department,
          doctorId
        });
      } else {
        await store.login(email, password);
      }
      router.push("/dashboard");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Invalid login.";
      if (/account created|account request submitted/i.test(text)) {
        setMessage(text);
      } else {
        setError(text);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-screen bg-slate-50 lg:grid-cols-[1fr_520px]">
      <section className="hidden bg-[linear-gradient(135deg,#0f6170,#2563eb)] px-14 py-16 text-white lg:flex lg:flex-col lg:justify-between">
        <div>
          <p className="mb-8 text-sm font-bold uppercase tracking-[0.18em] text-white/70">OCT Report Assistant</p>
          <h1 className="max-w-xl text-4xl font-black leading-tight">Clinical OCT reporting workspace.</h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-white/82">
            Manage patient records, OCT scan analysis, report drafts, and clinician approval in one controlled workflow.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {["Patient records", "OCT analysis", "Doctor review", "Approved reports"].map((item) => (
            <div key={item} className="rounded-lg border border-white/14 bg-white/10 p-4 font-bold backdrop-blur">{item}</div>
          ))}
        </div>
      </section>
      <section className="flex items-center justify-center px-5">
        <Card className="w-full max-w-md p-6">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">Secure clinical workspace</p>
              <h2 className="mt-2 text-2xl font-black text-slate-950">{authMode === "signin" ? "Sign in" : "Create account"}</h2>
            </div>
            <Button className="shrink-0" variant="secondary" onClick={() => setFeedbackOpen(true)}>
              <MessageSquare size={16} />
              Feedback
            </Button>
          </div>
          <div className="mb-6">
            <p className="mt-1 text-sm text-slate-500">
              {authMode === "signin"
                ? "Use your approved clinical account."
                : "Request access for your role. Accounts require email verification and administrator approval."}
            </p>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1">
              <button
                className={`rounded px-3 py-2 text-sm font-bold ${authMode === "signin" ? "bg-white text-clinic-700 shadow-sm" : "text-slate-500"}`}
                onClick={() => setAuthMode("signin")}
              >
                Sign in
              </button>
              <button
                className={`rounded px-3 py-2 text-sm font-bold ${authMode === "signup" ? "bg-white text-clinic-700 shadow-sm" : "text-slate-500"}`}
                onClick={() => {
                  setAuthMode("signup");
                }}
              >
                Create account
              </button>
            </div>
            <div>
              <label className="label">Email</label>
              <input className="field mt-1" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="field mt-1"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {authMode === "signup" ? (
              <>
                <div>
                  <label className="label">Full name</label>
                  <input className="field mt-1" value={fullName} onChange={(event) => setFullName(event.target.value)} />
                </div>
                <div>
                  <label className="label">Role requested</label>
                  <select className="field mt-1" value={requestedRole} onChange={(event) => setRequestedRole(event.target.value as Role)}>
                    <option value="doctor">Doctor</option>
                    <option value="assistant">Assistant / Technician</option>
                    <option value="admin">Admin / Records Staff</option>
                  </select>
                </div>
                <div>
                  <label className="label">Hospital / department</label>
                  <input className="field mt-1" value={department} onChange={(event) => setDepartment(event.target.value)} />
                </div>
                {requestedRole === "doctor" ? (
                  <div>
                    <label className="label">PMDC / doctor ID optional</label>
                    <input className="field mt-1" value={doctorId} onChange={(event) => setDoctorId(event.target.value)} />
                  </div>
                ) : null}
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                  New accounts remain pending until approved by the clinical administrator.
                </div>
              </>
            ) : null}
            {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
            {message ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{message}</p> : null}
            <Button className="w-full" onClick={submit} disabled={loading || !email || !password}>
              {loading ? <Loader2 className="animate-spin" size={16} /> : null}
              {authMode === "signin" ? "Sign in" : "Request access"}
            </Button>
            <div className="flex flex-wrap justify-between gap-3 text-sm">
              <Link href="/forgot-password" className="font-semibold text-clinic-700">
                Forgot password?
              </Link>
              <Link href="/reports/check" className="font-semibold text-clinic-700">
                Check report
              </Link>
            </div>
          </div>
        </Card>
      </section>
      {feedbackOpen ? <FeedbackDialog onClose={() => setFeedbackOpen(false)} /> : null}
    </main>
  );
}

export function ForgotPasswordView() {
  const store = useDemoStore();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const sendReset = async () => {
    setError("");
    setSent(false);
    setLoading(true);
    try {
      await store.resetPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send reset email.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="Reset password"
      subtitle="Enter your Supabase account email and we will send a reset link."
      action={
        <>
          <input className="field" placeholder="doctor@clinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Button className="w-full" onClick={sendReset} disabled={loading || !email}>
            {loading ? <Loader2 className="animate-spin" size={16} /> : null}
            Send reset link
          </Button>
          {sent ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">Reset link sent. Check your email.</p> : null}
          {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
        </>
      }
    />
  );
}

export function ResetPasswordView() {
  const router = useRouter();
  const store = useDemoStore();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const updatePassword = async () => {
    setError("");
    setMessage("");
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await store.updatePassword(password);
      setMessage("Password updated. You can sign in now.");
      window.setTimeout(() => router.push("/login"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="Create new password"
      subtitle="Enter the new password after opening the Supabase reset email link."
      action={
        <>
          <input className="field" type="password" placeholder="New password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <input className="field" type="password" placeholder="Confirm password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          <Button className="w-full" onClick={updatePassword} disabled={loading || !password || !confirmPassword}>
            {loading ? <Loader2 className="animate-spin" size={16} /> : null}
            Update password
          </Button>
          {message ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{message}</p> : null}
          {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
        </>
      }
    />
  );
}

export function ChangePasswordView() {
  const store = useDemoStore();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    setMessage("");
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirm password do not match.");
      return;
    }
    if (currentPassword === newPassword) {
      setError("New password must be different from the current password.");
      return;
    }

    setLoading(true);
    try {
      await store.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password changed successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageTitle
        title="Change Password"
        subtitle="Update your clinical account password after confirming your current password."
      />
      <Card className="max-w-xl p-5">
        <div className="space-y-4">
          <Field label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} />
          <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} />
          <Field label="Confirm new password" type="password" value={confirmPassword} onChange={setConfirmPassword} />
          {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
          {message ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{message}</p> : null}
          <Button onClick={submit} disabled={loading || !currentPassword || !newPassword || !confirmPassword}>
            {loading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            Change password
          </Button>
        </div>
      </Card>
    </>
  );
}

function AuthCard({ title, subtitle, action }: { title: string; subtitle: string; action: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-2xl font-black text-slate-950">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        <div className="mt-6 space-y-4">{action}</div>
        <Link href="/login" className="mt-5 inline-flex text-sm font-semibold text-clinic-700">
          Back to login
        </Link>
      </Card>
    </main>
  );
}

export function DashboardView() {
  const store = useDemoStore();
  const [feedbackCount, setFeedbackCount] = useState(0);
  const pending = store.data.reports.filter((report) => report.status !== "approved").length;
  const approved = store.data.reports.filter((report) => report.status === "approved").length;
  const today = new Date().toISOString().slice(0, 10);
  const todayReports = store.data.reports.filter((report) => report.createdAt.startsWith(today)).length;
  useEffect(() => {
    let cancelled = false;
    getFeedbackEntries()
      .then((entries) => {
        if (!cancelled) setFeedbackCount(entries.filter((entry) => entry.status !== "resolved").length);
      })
      .catch(() => {
        if (!cancelled) setFeedbackCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const stats = [
    ["Total patients", store.data.patients.length],
    ["Total scans", store.data.scans.length],
    ["Pending reports", pending],
    ["Approved reports", approved],
    ["Reports today", todayReports],
    ["Open feedback", feedbackCount]
  ];

  return (
    <>
      <PageTitle
        title="Clinical Dashboard"
        subtitle="Monitor patients, OCT scans, AI-assisted draft reports, and clinician review activity."
        action={
          <div className="grid gap-2 sm:flex">
            <Link href="/patients/new" className="block">
              <Button className="w-full">
                <Plus size={16} />
                New Patient
              </Button>
            </Link>
            <Link href="/scans/upload" className="block">
              <Button className="w-full" variant="secondary">
                <Upload size={16} />
                Upload OCT
              </Button>
            </Link>
            <Link href="/reports/history" className="block">
              <Button className="w-full" variant="secondary">
                <ClipboardCheck size={16} />
                Check Reports
              </Button>
            </Link>
          </div>
        }
      />
      <SafetyNotice />
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {stats.map(([label, value]) => (
          <Card key={label} className="p-5">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
          </Card>
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent Patients" subtitle="Open a patient profile to view scans and report history." />
          <div className="divide-y divide-slate-100">
            {store.data.patients.slice(0, 5).map((patient) => (
              <Link key={patient.id} href={`/patients/${patient.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
                <div>
                  <p className="font-bold text-slate-900">{patient.fullName}</p>
                  <p className="text-sm text-slate-500">{patient.patientCode}</p>
                </div>
                <p className="text-sm font-semibold text-clinic-700">Open</p>
              </Link>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent Reports" subtitle="Reports stay clearly separated by review status." />
          <ReportRows reports={store.data.reports.slice(0, 5)} />
        </Card>
      </div>
    </>
  );
}

export function NewPatientView() {
  const store = useDemoStore();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [createdPatient, setCreatedPatient] = useState<Patient | null>(null);
  const [form, setForm] = useState({
    patientCode: `MCS-OCT-${String(store.data.patients.length + 1).padStart(4, "0")}`,
    cnic: "",
    fullName: "",
    age: "",
    gender: "Female" as Gender,
    phone: "",
    email: "",
    address: "",
    diabetesHistory: "Unknown" as Patient["diabetesHistory"],
    previousEyeDisease: "",
    clinicalNotes: ""
  });

  const submit = async () => {
    setError("");
    setSuccess("");
    if (!form.patientCode || !form.cnic || !form.fullName || !form.age || !form.gender) {
      setError("Please enter patient ID, CNIC, name, age, and gender.");
      return;
    }
    if (!isValidCnic(form.cnic)) {
      setError("Please enter a valid 13-digit CNIC.");
      return;
    }
    if (!isValidPatientAge(form.age)) {
      setError("Please enter a valid age from 0 to 130.");
      return;
    }
    try {
      const patient = await store.createPatient({ ...form, cnic: formatCnic(form.cnic), age: Number(form.age) });
      const password = getPatientCurrentAccessPassword(patient);
      if (patient.email) {
        const result = await sendReportAccessEmail({
          toEmail: patient.email,
          patientName: patient.fullName,
          accessId: getPatientAccessId(patient),
          password,
          mode: "patient-created"
        });
        setSuccess(result.message);
      } else {
        setSuccess(`Patient saved. No email was entered, so share Access ID ${getPatientAccessId(patient)} and password ${password} manually.`);
      }
      setCreatedPatient(patient);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create patient.");
    }
  };

  return (
    <>
      <PageTitle title="New Patient" subtitle="Create a patient record before uploading an OCT image." />
      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Patient ID / MR Number" value={form.patientCode} onChange={(value) => setForm({ ...form, patientCode: value })} />
          <Field label="CNIC" value={form.cnic} placeholder="61101-2910291-3" maxLength={15} onChange={(value) => setForm({ ...form, cnic: formatCnic(value) })} />
          <Field label="Full name" value={form.fullName} onChange={(value) => setForm({ ...form, fullName: value })} />
          <Field label="Age" type="number" min={MIN_PATIENT_AGE} max={MAX_PATIENT_AGE} value={form.age} onChange={(value) => setForm({ ...form, age: cleanAgeInput(value) })} />
          <SelectField label="Gender" value={form.gender} options={["Female", "Male", "Other"]} onChange={(value) => setForm({ ...form, gender: value as Gender })} />
          <Field label="Phone number" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
          <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
          <Field label="Address" value={form.address} onChange={(value) => setForm({ ...form, address: value })} />
          <SelectField
            label="Diabetes history"
            value={form.diabetesHistory}
            options={["Yes", "No", "Unknown"]}
            onChange={(value) => setForm({ ...form, diabetesHistory: value as Patient["diabetesHistory"] })}
          />
          <Field label="Previous eye disease" value={form.previousEyeDisease} onChange={(value) => setForm({ ...form, previousEyeDisease: value })} />
          <Textarea label="Clinical notes" value={form.clinicalNotes} onChange={(value) => setForm({ ...form, clinicalNotes: value })} />
        </div>
        {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
        {success ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">
            <p>{success}</p>
            {createdPatient ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Info label="Access ID" value={getPatientAccessId(createdPatient)} />
                <Info label="Password" value={getPatientCurrentAccessPassword(createdPatient)} />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          {createdPatient ? (
            <Link href={`/patients/${createdPatient.id}`}>
              <Button className="w-full sm:w-auto" variant="secondary">Open Patient</Button>
            </Link>
          ) : null}
          <Button className="w-full sm:w-auto" onClick={submit}>
            <Save size={16} />
            Save Patient
          </Button>
        </div>
      </Card>
    </>
  );
}

export function SearchPatientsView() {
  const store = useDemoStore();
  const [query, setQuery] = useState("");
  const results = store.data.patients.filter((patient) => {
    const value = `${patient.patientCode} ${patient.cnic ?? ""} ${patient.fullName} ${patient.phone}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });
  return (
    <>
      <PageTitle title="Search Patient" subtitle="Find records by patient ID, CNIC, name, or phone number." />
      <Card className="p-5">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
          <input className="field pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search MCS-OCT-0001, CNIC, patient name, phone..." />
        </div>
      </Card>
      <Card className="mt-5 overflow-hidden">
        <PatientTable patients={results} scans={store.data.scans} reports={store.data.reports} />
      </Card>
    </>
  );
}

export function PatientProfileView({ id }: { id: string }) {
  const router = useRouter();
  const store = useDemoStore();
  const patient = store.data.patients.find((item) => item.id === id);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [form, setForm] = useState({
    patientCode: patient?.patientCode ?? "",
    cnic: patient?.cnic ?? "",
    fullName: patient?.fullName ?? "",
    age: patient ? String(patient.age) : "",
    gender: patient?.gender ?? "Female" as Gender,
    phone: patient?.phone ?? "",
    email: patient?.email ?? "",
    address: patient?.address ?? "",
    diabetesHistory: patient?.diabetesHistory ?? "Unknown" as Patient["diabetesHistory"],
    previousEyeDisease: patient?.previousEyeDisease ?? "",
    clinicalNotes: patient?.clinicalNotes ?? ""
  });

  useEffect(() => {
    if (!patient) return;
    setForm({
      patientCode: patient.patientCode,
      cnic: patient.cnic ?? "",
      fullName: patient.fullName,
      age: String(patient.age),
      gender: patient.gender,
      phone: patient.phone ?? "",
      email: patient.email ?? "",
      address: patient.address ?? "",
      diabetesHistory: patient.diabetesHistory,
      previousEyeDisease: patient.previousEyeDisease ?? "",
      clinicalNotes: patient.clinicalNotes ?? ""
    });
  }, [patient?.id, patient?.updatedAt]);

  if (!patient) return <Missing title="Patient not found" href="/patients/search" label="Back to search" />;
  const scans = store.data.scans.filter((scan) => scan.patientId === patient.id);
  const reports = store.data.reports.filter((report) => report.patientId === patient.id);
  const accessPassword = getPatientCurrentAccessPassword(patient);
  const accessId = getPatientAccessId(patient);

  const savePatient = async () => {
    setError("");
    setSaved("");
    if (!isValidCnic(form.cnic)) {
      setError("Please enter a valid 13-digit CNIC.");
      return;
    }
    if (!isValidPatientAge(form.age)) {
      setError("Please enter a valid age from 0 to 130.");
      return;
    }
    setSaving(true);
    try {
      await store.updatePatient(patient.id, { ...form, cnic: formatCnic(form.cnic), age: Number(form.age) });
      setEditing(false);
      setSaved("Patient details updated.");
      window.setTimeout(() => setSaved(""), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update patient.");
    } finally {
      setSaving(false);
    }
  };

  const deletePatient = async () => {
    if (!window.confirm("Delete this patient and linked scans/reports?")) return;
    setError("");
    setDeleting(true);
    try {
      await store.deletePatient(patient.id);
      router.push("/patients/search");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete patient.");
      setDeleting(false);
    }
  };

  return (
    <>
      <PageTitle
        title={patient.fullName}
        subtitle={`${patient.patientCode} | ${patient.age} years | ${patient.gender}`}
        action={
          <div className="grid gap-2 sm:flex">
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => setEditing((value) => !value)}>
              {editing ? "Cancel Edit" : "Edit Patient"}
            </Button>
            <Button className="w-full sm:w-auto" variant="danger" disabled={deleting} onClick={deletePatient}>
              {deleting ? <Loader2 className="animate-spin" size={16} /> : null}
              Delete Patient
            </Button>
            <Link href={`/scans/upload?patient=${patient.id}`} className="block">
              <Button className="w-full">
                <Upload size={16} />
                Upload New OCT Scan
              </Button>
            </Link>
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card className="p-5">
          <h3 className="font-black text-slate-950">Patient Information</h3>
          {!editing ? (
            <>
              <Info label="Email" value={patient.email || "Not provided"} />
              <Info label="Phone" value={patient.phone || "Not provided"} />
              <Info label="Address" value={patient.address || "Not provided"} />
              <Info label="Diabetes history" value={patient.diabetesHistory} />
              <Info label="Previous eye disease" value={patient.previousEyeDisease || "None noted"} />
              <Info label="Doctor notes" value={patient.clinicalNotes || "No notes"} />
              <Info label="CNIC" value={patient.cnic || "Not provided"} />
              <Info label="Access ID" value={accessId} />
              <Info label="Access password" value={accessPassword} />
            </>
          ) : (
            <div className="mt-4 grid gap-4">
              <Field label="Patient ID / MR Number" value={form.patientCode} onChange={(value) => setForm({ ...form, patientCode: value })} />
              <Field label="CNIC" value={form.cnic} placeholder="61101-2910291-3" maxLength={15} onChange={(value) => setForm({ ...form, cnic: formatCnic(value) })} />
              <Field label="Full name" value={form.fullName} onChange={(value) => setForm({ ...form, fullName: value })} />
              <Field label="Age" type="number" min={MIN_PATIENT_AGE} max={MAX_PATIENT_AGE} value={form.age} onChange={(value) => setForm({ ...form, age: cleanAgeInput(value) })} />
              <SelectField label="Gender" value={form.gender} options={["Female", "Male", "Other"]} onChange={(value) => setForm({ ...form, gender: value as Gender })} />
              <Field label="Phone number" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
              <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
              <Field label="Address" value={form.address} onChange={(value) => setForm({ ...form, address: value })} />
              <SelectField
                label="Diabetes history"
                value={form.diabetesHistory}
                options={["Yes", "No", "Unknown"]}
                onChange={(value) => setForm({ ...form, diabetesHistory: value as Patient["diabetesHistory"] })}
              />
              <Field label="Previous eye disease" value={form.previousEyeDisease} onChange={(value) => setForm({ ...form, previousEyeDisease: value })} />
              <Textarea label="Doctor notes" value={form.clinicalNotes} onChange={(value) => setForm({ ...form, clinicalNotes: value })} />
              <Button onClick={savePatient} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                Save Changes
              </Button>
            </div>
          )}
          {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
          {saved ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{saved}</p> : null}
        </Card>
        <Card>
          <CardHeader title="Uploaded Scans" subtitle="Each scan links to the AI analysis page." />
          {scans.length ? (
            <div className="divide-y divide-slate-100">
              {scans.map((scan) => {
                const ai = store.data.aiResults.find((result) => result.scanId === scan.id);
                const report = store.data.reports.find((item) => item.scanId === scan.id);
                return (
                  <div key={scan.id} className="grid gap-4 px-5 py-4 md:grid-cols-[92px_1fr_auto] md:items-center">
                    <img src={scan.imageUrl} alt="OCT thumbnail" className="h-20 w-24 rounded-md border border-slate-200 object-cover" />
                    <div>
                      <p className="font-bold text-slate-900">{new Date(scan.createdAt).toLocaleString()}</p>
                      <p className="text-sm text-slate-500">Eye side: {scan.eyeSide}</p>
                      <p className="text-sm text-slate-500">
                        AI: {ai ? `${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)` : "Not analyzed"}
                      </p>
                    </div>
                    <div className="grid gap-2 sm:flex sm:flex-wrap">
                      {report ? <StatusBadge status={report.status} /> : null}
                      <Link href={`/scans/${scan.id}/analysis`} className="block">
                        <Button className="w-full" variant="secondary">Open Analysis</Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-5">
              <EmptyState title="No scans yet" body="Upload an OCT scan to start analysis." />
            </div>
          )}
        </Card>
      </div>
      <Card className="mt-5">
        <CardHeader title="Report History" />
        <ReportRows reports={reports} />
      </Card>
    </>
  );
}

export function UploadScanView() {
  const router = useRouter();
  const store = useDemoStore();
  const [patientId, setPatientId] = useState("");
  const [eyeSide, setEyeSide] = useState<EyeSide>("Unknown");
  const [scanNotes, setScanNotes] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [predictionFile, setPredictionFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [analysisWarning, setAnalysisWarning] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [loading, setLoading] = useState(false);

  const onFile = async (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setError("Only JPG, JPEG, and PNG OCT images are supported.");
      return;
    }
    setError("");
    setAnalysisWarning("");
    setFileNote("");
    try {
      const prepared = await prepareScanImages(file);
      setSelectedFile(prepared.storageFile);
      setPredictionFile(prepared.predictionFile);
      if (prepared.storageFile.size < prepared.originalSize || prepared.predictionFile.size < prepared.originalSize) {
        setFileNote(
          `Optimized image for faster analysis: ${(prepared.originalSize / 1024 / 1024).toFixed(1)} MB -> ${(prepared.predictionSize / 1024 / 1024).toFixed(1)} MB.`
        );
      }
      const reader = new FileReader();
      reader.onload = () => setImageUrl(String(reader.result));
      reader.readAsDataURL(prepared.storageFile);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare the selected image.");
      setSelectedFile(null);
      setPredictionFile(null);
      setImageUrl("");
    }
  };

  const submit = async () => {
    setError("");
    setAnalysisWarning("");
    if (!patientId || !imageUrl || !selectedFile || !predictionFile) {
      setError("Please select a patient and upload an OCT image.");
      return;
    }
    setLoading(true);
    try {
      const prediction = await predictOCT(predictionFile);
      if (!prediction.is_valid_oct) {
        const message =
          prediction.prediction === "INVALID_IMAGE"
            ? "Invalid image uploaded. Please upload a valid OCT scan."
            : "Low-confidence result. AI could not confidently classify this scan. Requires doctor review.";
        setAnalysisWarning(`${message} ${prediction.disclaimer}`);
        return;
      }

      const scan = await store.addScan({ patientId, imageUrl, eyeSide, scanNotes, file: selectedFile });
      const aiResult = await store.saveBackendAnalysis(scan, prediction);
      await store.createReport(scan, aiResult);
      router.push(`/scans/${scan.id}/analysis`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI prediction failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageTitle title="Upload OCT Scan" subtitle="Upload a patient OCT image for AI-assisted classification and draft report preparation." />
      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
        <Card className="p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              label="Patient"
              value={patientId}
              options={["", ...store.data.patients.map((patient) => patient.id)]}
              optionLabels={{ "": "Select patient", ...Object.fromEntries(store.data.patients.map((patient) => [patient.id, `${patient.patientCode} - ${patient.fullName}`])) }}
              onChange={setPatientId}
            />
            <SelectField label="Eye side" value={eyeSide} options={["Left", "Right", "Both", "Unknown"]} onChange={(value) => setEyeSide(value as EyeSide)} />
          </div>
          <Textarea label="Scan notes" value={scanNotes} onChange={setScanNotes} />
          <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 px-5 py-12 text-center hover:border-clinic-300">
            <Upload className="text-clinic-600" size={28} />
            <span className="mt-3 font-bold text-slate-900">Upload OCT image</span>
            <span className="text-sm text-slate-500">JPG, JPEG, or PNG</span>
            <input className="hidden" type="file" accept=".jpg,.jpeg,.png" onChange={(event) => onFile(event.target.files?.[0])} />
          </label>
          {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
          {fileNote ? <p className="mt-4 rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">{fileNote}</p> : null}
          {analysisWarning ? <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{analysisWarning}</p> : null}
          <div className="mt-5 flex justify-end">
            <Button className="w-full sm:w-auto" onClick={submit} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
              {loading ? "Analyzing with EfficientNet-B3..." : "Save and Analyze"}
            </Button>
          </div>
        </Card>
        <Card className="p-5">
          <h3 className="font-black text-slate-950">Image Preview</h3>
          {imageUrl ? (
            <img src={imageUrl} alt="Uploaded OCT preview" className="mt-4 aspect-[4/3] w-full rounded-md border border-slate-200 object-cover" />
          ) : (
            <div className="mt-4">
              <EmptyState title="No image selected" body="The OCT preview appears here before upload." />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export function AnalysisView({ id }: { id: string }) {
  const router = useRouter();
  const store = useDemoStore();
  const [analysisError, setAnalysisError] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [scanActionLoading, setScanActionLoading] = useState(false);
  const scan = store.data.scans.find((item) => item.id === id);
  if (!scan) return <Missing title="Scan not found" href="/dashboard" label="Back to dashboard" />;
  const patient = store.data.patients.find((item) => item.id === scan.patientId);
  const aiResult = store.data.aiResults.find((item) => item.scanId === scan.id);
  const linkedReport = aiResult ? store.data.reports.find((report) => report.aiResultId === aiResult.id) : undefined;
  const canManageAnalysis = store.currentUser.role === "doctor" || store.currentUser.role === "admin";
  const canManageScan = canManageAnalysis;

  const analyzeScan = async () => {
    setAnalysisError("");
    setAnalysisLoading(true);
    try {
      const response = await fetch(scan.imageUrl);
      if (!response.ok) throw new Error("Could not reload the scan image for analysis.");
      const blob = await response.blob();
      const file = new File([blob], `${scan.id}.jpg`, { type: blob.type || "image/jpeg" });
      const prepared = await prepareScanImages(file);
      const prediction = await predictOCT(prepared.predictionFile);
      const result = await store.saveBackendAnalysis(scan, prediction);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI analysis failed.";
      setAnalysisError(message);
      throw err;
    } finally {
      setAnalysisLoading(false);
    }
  };

  const generate = async () => {
    const result = aiResult ?? (await analyzeScan());
    const report = await store.createReport(scan, result);
    if (patient?.email) {
      try {
        await sendReportAccessEmail({
          toEmail: patient.email,
          patientName: patient.fullName,
          accessId: getPatientAccessId(patient),
          password: getPatientCurrentAccessPassword(patient),
          mode: "report-registered"
        });
      } catch {
        // Report generation should not fail if the courtesy email cannot be sent.
      }
    }
    router.push(`/reports/${report.id}/edit`);
  };

  const changeScanPhoto = async (file: File) => {
    setAnalysisError("");
    if (linkedReport && !window.confirm("Changing this scan image will delete the linked analysis and report because they belong to the old image. Continue?")) return;
    setScanActionLoading(true);
    try {
      const prepared = await prepareScanImages(file);
      await store.replaceScanImage(scan.id, prepared.storageFile);
      router.refresh();
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Could not change scan photo.");
    } finally {
      setScanActionLoading(false);
    }
  };

  const deleteCurrentScan = async () => {
    setAnalysisError("");
    if (!window.confirm("Delete this scan, its analysis, and any linked report? This cannot be undone.")) return;
    setScanActionLoading(true);
    try {
      await store.deleteScan(scan.id);
      router.push(`/patients/${scan.patientId}`);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Could not delete scan.");
      setScanActionLoading(false);
    }
  };

  return (
    <>
      <PageTitle
        title="AI Analysis"
        subtitle={patient ? `${patient.patientCode} - ${patient.fullName}` : "OCT scan analysis"}
        action={
          <Button className="w-full" onClick={generate}>
            <FileText size={16} />
            Generate Report
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <Card className="p-5">
          <img src={scan.imageUrl} alt="OCT scan" className="aspect-[4/3] w-full rounded-md bg-slate-900 object-cover" />
          <ScanImageActions
            scan={scan}
            patientCode={patient?.patientCode}
            canManage={canManageScan}
            busy={scanActionLoading}
            onChangePhoto={changeScanPhoto}
            onDeleteScan={deleteCurrentScan}
          />
        </Card>
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-black text-slate-950">Model Output</h3>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">EfficientNet-B3</span>
          </div>
          <SafetyNotice />
          {analysisError ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{analysisError}</p> : null}
          {aiResult ? (
            <div className="mt-5 space-y-5">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-500">AI Prediction</p>
                <p className="mt-1 text-4xl font-black text-clinic-700">{aiResult.predictedClass}</p>
                <p className="mt-1 text-sm text-slate-500">Confidence {Math.round(aiResult.confidence * 100)}%</p>
              </div>
              <div className="space-y-3">
                {diseaseClasses.map((item) => (
                  <Probability key={item} label={item} value={aiResult.probabilities[item]} active={item === aiResult.predictedClass} />
                ))}
              </div>
              {aiResult.heatmapUrl ? (
                <div className="rounded-md border border-slate-200 bg-white p-3">
                  <p className="text-sm font-black text-slate-950">AI attention heatmap</p>
                  <img src={aiResult.heatmapUrl} alt="Grad-CAM heatmap overlay" className="mt-3 aspect-[4/3] w-full rounded-md bg-slate-900 object-cover" />
                  <p className="mt-2 text-xs font-medium leading-relaxed text-slate-500">
                    Highlighted regions influenced the AI classification. This is not a segmentation map or measurement.
                  </p>
                </div>
              ) : null}
              <Info label="Model" value={`${aiResult.modelName} ${aiResult.modelVersion}`} />
              <Info label="Timestamp" value={new Date(aiResult.createdAt).toLocaleString()} />
              <div className="grid gap-2 sm:flex">
                <Button className="w-full sm:w-auto" variant="secondary" onClick={analyzeScan} disabled={analysisLoading}>
                  {analysisLoading ? <Loader2 className="animate-spin" size={16} /> : <RotateCcw size={16} />}
                  {analysisLoading ? "Re-analyzing..." : "Re-run Analysis"}
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  variant="danger"
                  disabled={!canManageAnalysis}
                  onClick={async () => {
                    if (!aiResult) return;
                    const message = linkedReport
                      ? "Delete this analysis and its linked report? This cannot be undone."
                      : "Delete this analysis result? This cannot be undone.";
                    if (!window.confirm(message)) return;
                    try {
                      await store.deleteAnalysis(aiResult.id);
                      router.push(`/patients/${scan.patientId}`);
                    } catch (err) {
                      setAnalysisError(err instanceof Error ? err.message : "Could not delete analysis.");
                    }
                  }}
                >
                  Delete Analysis
                </Button>
                <Link href={`/patients/${scan.patientId}`} className="block">
                  <Button className="w-full sm:w-auto" variant="ghost">Back to Patient</Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-5">
              <EmptyState title="No result yet" body="Run analysis to create an AI-assisted classification for this scan." />
              <Button className="mt-4 w-full sm:w-auto" onClick={analyzeScan} disabled={analysisLoading}>
                {analysisLoading ? <Loader2 className="animate-spin" size={16} /> : null}
                {analysisLoading ? "Analyzing..." : "Run Analysis"}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export function ReportEditorView({ id }: { id: string }) {
  const router = useRouter();
  const store = useDemoStore();
  const report = store.data.reports.find((item) => item.id === id);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");
  const [scanWorking, setScanWorking] = useState(false);
  const [draft, setDraft] = useState<Report | undefined>(report);

  useEffect(() => {
    if (report) setDraft(report);
  }, [report?.id]);

  if (!store.ready) return <Missing title="Loading report" href="/reports/history" label="Back to history" />;
  if (!report || !draft) return <Missing title="Report not found" href="/reports/history" label="Back to history" />;
  const patient = store.data.patients.find((item) => item.id === draft.patientId);
  const scan = store.data.scans.find((item) => item.id === draft.scanId);
  const ai = store.data.aiResults.find((item) => item.id === draft.aiResultId);
  const canApprove = store.currentUser.role === "doctor";
  const canManageScan = store.currentUser.role === "doctor" || store.currentUser.role === "admin";
  const patientAccessId = patient ? getPatientAccessId(patient) : "";

  const save = async (status: Report["status"] = draft.status) => {
    const next = { ...draft, status };
    try {
      await store.saveReport(next);
      setDraft(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save report.");
    }
  };

  const deleteCurrentReport = async () => {
    setError("");
    if (!window.confirm("Delete this report permanently?")) return;
    try {
      await store.deleteReport(draft.id);
      router.push("/reports/history");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete report.");
    }
  };

  const changeScanPhoto = async (file: File) => {
    if (!scan) return;
    setError("");
    if (!window.confirm("Changing this scan image will delete this report and the linked analysis because they belong to the old image. Continue?")) return;
    setScanWorking(true);
    try {
      const prepared = await prepareScanImages(file);
      await store.replaceScanImage(scan.id, prepared.storageFile);
      router.push(`/scans/${scan.id}/analysis`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change scan photo.");
      setScanWorking(false);
    }
  };

  const deleteCurrentScan = async () => {
    if (!scan) return;
    setError("");
    if (!window.confirm("Delete this scan, its analysis, and this report? This cannot be undone.")) return;
    setScanWorking(true);
    try {
      await store.deleteScan(scan.id);
      router.push(`/patients/${scan.patientId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete scan.");
      setScanWorking(false);
    }
  };

  const approve = async () => {
    setError("");
    setAccessMessage("");
    try {
      const approved = await store.approveReport(draft);
      const accessPassword = patient ? getPatientCurrentAccessPassword(patient) : "";
      try {
        if (patient?.email && accessPassword) {
          const emailResult = await sendReportAccessEmail({
            toEmail: patient.email,
            patientName: patient.fullName,
            accessId: patientAccessId,
            password: accessPassword,
            mode: "report-ready"
          });
          setAccessMessage(emailResult.message);
        } else {
          setAccessMessage(`No patient email saved. Share Access ID ${patientAccessId || "-"} and password ${accessPassword || "-"} manually.`);
        }
      } catch {
        setAccessMessage(`Report approved. Email could not be sent automatically. Share Access ID ${patientAccessId || "-"} and password ${accessPassword || "-"} manually.`);
      }
      router.push(`/reports/${approved.id}/view`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve report.");
    }
  };

  return (
    <>
      <PageTitle title="Report Editor" subtitle="Doctors can approve final reports. Other roles can save drafts for review." />
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <Card className="p-5">
          {patient ? <Info label="Patient" value={`${patient.patientCode} - ${patient.fullName}`} /> : null}
          {patient ? <Info label="Patient access ID" value={patientAccessId} /> : null}
          {patient ? <Info label="Access password" value={getPatientCurrentAccessPassword(patient)} /> : null}
          {ai ? (
            <>
              <Info label="AI prediction" value={`${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)`} />
              <SafetyNotice />
            </>
          ) : null}
          {scan ? (
            <>
              <img src={scan.imageUrl} alt="OCT scan" className="mt-4 aspect-[4/3] w-full rounded-md object-cover" />
              <ScanImageActions
                scan={scan}
                patientCode={patient?.patientCode}
                canManage={canManageScan}
                busy={scanWorking}
                onChangePhoto={changeScanPhoto}
                onDeleteScan={deleteCurrentScan}
              />
            </>
          ) : null}
        </Card>
        <Card className="p-5">
          <div className="grid gap-4">
            <Textarea label="Findings" value={draft.findings} onChange={(value) => setDraft({ ...draft, findings: value })} />
            <Textarea label="Impression" value={draft.impression} onChange={(value) => setDraft({ ...draft, impression: value })} />
            <Textarea label="Recommendation" value={draft.recommendation} onChange={(value) => setDraft({ ...draft, recommendation: value })} />
            <Textarea label="Doctor notes" value={draft.doctorNotes} onChange={(value) => setDraft({ ...draft, doctorNotes: value })} />
            <SelectField
              label="Final diagnosis"
              value={draft.finalDiagnosis}
              options={["Needs clinical correlation", ...diseaseClasses]}
              onChange={(value) => setDraft({ ...draft, finalDiagnosis: value as Report["finalDiagnosis"] })}
            />
          </div>
          {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
          {saved ? <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">Draft saved.</p> : null}
          {accessMessage ? <p className="mt-4 rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">{accessMessage}</p> : null}
          <div className="mt-5 grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => save("draft")}>
              <Save size={16} />
              Save Draft
            </Button>
            <Button className="w-full sm:w-auto" variant="secondary" onClick={() => save("pending_review")}>Needs Review</Button>
            {canApprove ? (
              <>
                <Button className="w-full sm:w-auto" variant="secondary" onClick={() => save("rejected")}>Reject</Button>
                <Button className="w-full sm:w-auto" variant="secondary" onClick={() => save("superseded")}>Mark Superseded</Button>
                <Button className="w-full sm:w-auto" variant="danger" onClick={deleteCurrentReport}>
                  <Trash2 size={16} />
                  Delete
                </Button>
                <Button className="w-full sm:w-auto" onClick={approve}>
                  <CheckCircle2 size={16} />
                  Approve Report
                </Button>
              </>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}

export function ReportView({ id }: { id: string }) {
  const router = useRouter();
  const store = useDemoStore();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const report = store.data.reports.find((item) => item.id === id);
  if (!report) return <Missing title="Report not found" href="/reports/history" label="Back to history" />;
  const patient = store.data.patients.find((item) => item.id === report.patientId);
  const scan = store.data.scans.find((item) => item.id === report.scanId);
  const ai = store.data.aiResults.find((item) => item.id === report.aiResultId);
  const approver = store.data.profiles.find((item) => item.id === report.approvedBy);
  const canDoctorEdit = store.currentUser.role === "doctor";
  const canManageScan = store.currentUser.role === "doctor" || store.currentUser.role === "admin";

  const updateStatus = async (status: Report["status"]) => {
    setError("");
    setWorking(true);
    try {
      await store.saveReport({ ...report, status });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update report.");
    } finally {
      setWorking(false);
    }
  };

  const deleteCurrentReport = async () => {
    setError("");
    if (!window.confirm("Delete this report permanently?")) return;
    setWorking(true);
    try {
      await store.deleteReport(report.id);
      router.push("/reports/history");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete report.");
      setWorking(false);
    }
  };

  const changeScanPhoto = async (file: File) => {
    if (!scan) return;
    setError("");
    if (!window.confirm("Changing this scan image will delete this report and the linked analysis because they belong to the old image. Continue?")) return;
    setWorking(true);
    try {
      const prepared = await prepareScanImages(file);
      await store.replaceScanImage(scan.id, prepared.storageFile);
      router.push(`/scans/${scan.id}/analysis`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change scan photo.");
      setWorking(false);
    }
  };

  const deleteCurrentScan = async () => {
    if (!scan) return;
    setError("");
    if (!window.confirm("Delete this scan, its analysis, and linked reports? This cannot be undone.")) return;
    setWorking(true);
    try {
      await store.deleteScan(scan.id);
      router.push(`/patients/${scan.patientId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete scan.");
      setWorking(false);
    }
  };

  return (
    <>
      <PageTitle
        title="Report View"
        subtitle={patient ? `${patient.patientCode} - ${patient.fullName}` : "Approved report"}
        action={
          patient && scan && ai ? (
            <div className="grid gap-2 sm:flex">
              <Link href={`/reports/${report.id}/edit`} className="block">
                <Button className="w-full sm:w-auto" variant="secondary">
                  <Edit3 size={16} />
                  Edit
                </Button>
              </Link>
              <Button className="w-full sm:w-auto" onClick={() => downloadReportPdf({ patient, scan, aiResult: ai, report, approver })}>
                <Download size={16} />
                Download PDF
              </Button>
            </div>
          ) : null
        }
      />
      <Card className="p-6">
        {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xl font-black text-slate-950">
              {report.status === "approved" ? "Doctor-Approved OCT Report" : report.status === "rejected" ? "Rejected OCT Report" : report.status === "superseded" ? "Superseded OCT Report" : "OCT Report"}
            </h3>
            <p className="mt-1 text-sm text-slate-500">Final status depends on doctor approval.</p>
          </div>
          <StatusBadge status={report.status} />
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-[320px_1fr]">
          <div>
            {scan ? (
              <>
                <img src={scan.imageUrl} alt="OCT scan" className="aspect-[4/3] w-full rounded-md object-cover" />
                <ScanImageActions
                  scan={scan}
                  patientCode={patient?.patientCode}
                  canManage={canManageScan}
                  busy={working}
                  onChangePhoto={changeScanPhoto}
                  onDeleteScan={deleteCurrentScan}
                />
              </>
            ) : null}
            <div className="mt-4 space-y-3">
              {patient ? <Info label="Patient access ID" value={getPatientAccessId(patient)} /> : null}
              {patient ? <Info label="Access password" value={getPatientCurrentAccessPassword(patient)} /> : null}
              {patient ? <Info label="Patient" value={`${patient.patientCode} - ${patient.fullName}`} /> : null}
              {ai ? <Info label="AI prediction" value={`${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)`} /> : null}
              <Info label="Approved by" value={approver?.fullName ?? "Not approved"} />
              <Info label="Approved at" value={report.approvedAt ? new Date(report.approvedAt).toLocaleString() : "Not approved"} />
            </div>
          </div>
          <div className="space-y-5">
            <SafetyNotice />
            <ReportSection title="Findings" body={report.findings} />
            <ReportSection title="Impression" body={report.impression} />
            <ReportSection title="Recommendation" body={report.recommendation} />
            <ReportSection title="Doctor Notes" body={report.doctorNotes || "No additional notes."} />
            <ReportSection title="Final Diagnosis" body={report.finalDiagnosis} />
            {canDoctorEdit ? (
              <div className="grid gap-2 border-t border-slate-100 pt-5 sm:flex sm:flex-wrap sm:justify-end">
                <Button className="w-full sm:w-auto" variant="secondary" disabled={working} onClick={() => updateStatus("rejected")}>Reject Report</Button>
                <Button className="w-full sm:w-auto" variant="secondary" disabled={working} onClick={() => updateStatus("superseded")}>Mark Superseded</Button>
                <Button className="w-full sm:w-auto" variant="danger" disabled={working} onClick={deleteCurrentReport}>
                  <Trash2 size={16} />
                  Delete Report
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </>
  );
}

export function ReportHistoryView() {
  const store = useDemoStore();
  const [query, setQuery] = useState("");
  const reports = store.data.reports.filter((report) => {
    const patient = store.data.patients.find((item) => item.id === report.patientId);
    const ai = store.data.aiResults.find((item) => item.id === report.aiResultId);
    return `${patient?.patientCode} ${patient?.cnic ?? ""} ${patient?.fullName} ${report.status} ${ai?.predictedClass} ${report.finalDiagnosis}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });
  return (
    <>
      <PageTitle title="Report History" subtitle="Search by patient ID, CNIC, name, status, AI prediction, or final diagnosis." />
      <Card className="p-5">
        <input className="field" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search CNIC, name, status, or diagnosis..." />
      </Card>
      <Card className="mt-5">
        <ReportRows reports={reports} />
      </Card>
    </>
  );
}

export function PatientReportCheckView() {
  const store = useDemoStore();
  const [accessId, setAccessId] = useState("");
  const [password, setPassword] = useState("");
  const [publicResult, setPublicResult] = useState<PublicReportResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ accessId: "", oldPassword: "", newPassword: "", confirmPassword: "" });
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const normalizedAccessId = accessId.trim().toLowerCase();
  const normalizedPassword = password.trim();
  const match = useMemo(() => {
    if (!normalizedAccessId || !normalizedPassword) return null;
    const patient = store.data.patients.find((item) => getPatientAccessId(item).toLowerCase() === normalizedAccessId || item.patientCode.toLowerCase() === normalizedAccessId);
    if (!patient || getPatientCurrentAccessPassword(patient) !== normalizedPassword) return null;
    return store.data.reports.find((report) => report.patientId === patient.id && report.status === "approved") ??
      store.data.reports.find((report) => report.patientId === patient.id) ??
      null;
  }, [normalizedPassword, normalizedAccessId, store.data.patients, store.data.reports]);
  const patient = match ? store.data.patients.find((item) => item.id === match.patientId) : store.data.patients.find((item) => getPatientAccessId(item).toLowerCase() === normalizedAccessId || item.patientCode.toLowerCase() === normalizedAccessId);
  const ai = match ? store.data.aiResults.find((item) => item.id === match.aiResultId) : null;
  const localApprover = match ? store.data.profiles.find((item) => item.id === match.approvedBy) : undefined;
  const publicReport = publicResult?.report;
  const localReportHistory = patient
    ? store.data.reports
        .filter((report) => report.patientId === patient.id && ["approved", "rejected", "superseded"].includes(report.status))
        .sort((left, right) => new Date(right.approvedAt ?? right.createdAt).getTime() - new Date(left.approvedAt ?? left.createdAt).getTime())
        .map((report) => {
          const result = store.data.aiResults.find((item) => item.id === report.aiResultId);
          const approver = store.data.profiles.find((item) => item.id === report.approvedBy);
          return toPublicReport(report, patient, result, approver?.fullName);
        })
    : [];
  const publicReportHistory = publicResult?.reports?.length ? publicResult.reports : localReportHistory;

  const checkReport = async () => {
    setCheckError("");
    setPublicResult(null);
    if (!accessId.trim() || !password.trim()) return;
    if (match) return;

    setChecking(true);
    try {
      const result = await checkPublicReport(accessId.trim(), password.trim());
      setPublicResult(result);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Could not check report.");
    } finally {
      setChecking(false);
    }
  };

  const changeAccessPassword = async () => {
    setPasswordError("");
    setPasswordMessage("");
    if (!passwordForm.accessId.trim() || !passwordForm.oldPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
      setPasswordError("Enter CNIC/access ID, old password, and the new password twice.");
      return;
    }
    if (passwordForm.newPassword.length < 6) {
      setPasswordError("New password must be at least 6 characters.");
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError("New password and confirm password do not match.");
      return;
    }
    setPasswordChanging(true);
    try {
      const result = await changePatientAccessPassword({
        accessId: cleanAccessIdInput(passwordForm.accessId),
        oldPassword: passwordForm.oldPassword,
        newPassword: passwordForm.newPassword
      });
      setPasswordMessage(result.message);
      setPasswordForm({ accessId: cleanAccessIdInput(passwordForm.accessId), oldPassword: "", newPassword: "", confirmPassword: "" });
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setPasswordChanging(false);
    }
  };

  return (
    <>
      <PageTitle
        title="Check Report"
        subtitle="Enter the CNIC access ID and generated password sent by the clinic. Reports open only after doctor approval."
        action={
          <Button variant="secondary" onClick={() => setFeedbackOpen(true)}>
            <MessageSquare size={16} />
            Feedback / complaint
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
        <Card className="p-5">
          <div className="grid gap-4">
            <Field label="CNIC access ID" value={accessId} placeholder="6110129102913" onChange={(value) => setAccessId(cleanAccessIdInput(value))} />
            <Field label="Access password" value={password} onChange={setPassword} />
            <Button onClick={checkReport} disabled={checking || !accessId.trim() || !password.trim()}>
              {checking ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
              Check Report
            </Button>
          </div>
          <div className="mt-5 rounded-md border border-slate-200 bg-slate-50 p-4">
            <p className="font-bold text-slate-950">Access flow</p>
            <div className="mt-3 space-y-3 text-sm font-semibold text-slate-600">
              <p>1. Clinic creates and reviews the OCT report.</p>
              <p>2. Patient receives their CNIC without dashes as the access ID, plus a password like Xisn12H.</p>
              <p>3. Approved reports can be viewed, downloaded, and printed.</p>
            </div>
          </div>
          <div className="mt-4 rounded-md border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-bold text-slate-950">Patient password</p>
                <p className="mt-1 text-sm font-semibold text-slate-500">Keep the generated password or set your own.</p>
              </div>
              <Button variant="secondary" onClick={() => setPasswordOpen((value) => !value)}>
                {passwordOpen ? "Close" : "Change password"}
              </Button>
            </div>
            {passwordOpen ? (
              <div className="mt-4 grid gap-3">
                <Field label="CNIC access ID" value={passwordForm.accessId} placeholder="6110129102913" onChange={(value) => setPasswordForm({ ...passwordForm, accessId: cleanAccessIdInput(value) })} />
                <Field label="Old password" type="password" value={passwordForm.oldPassword} onChange={(value) => setPasswordForm({ ...passwordForm, oldPassword: value })} />
                <Field label="New password" type="password" value={passwordForm.newPassword} onChange={(value) => setPasswordForm({ ...passwordForm, newPassword: value })} />
                <Field label="Confirm new password" type="password" value={passwordForm.confirmPassword} onChange={(value) => setPasswordForm({ ...passwordForm, confirmPassword: value })} />
                {passwordError ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{passwordError}</p> : null}
                {passwordMessage ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{passwordMessage}</p> : null}
                <Button onClick={changeAccessPassword} disabled={passwordChanging}>
                  {passwordChanging ? <Loader2 className="animate-spin" size={16} /> : null}
                  Update patient password
                </Button>
              </div>
            ) : null}
          </div>
          <div className="mt-4 rounded-md border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-bold text-slate-950">Past reports</p>
                <p className="mt-1 text-sm font-semibold text-slate-500">View previous approved, rejected, or superseded reports.</p>
              </div>
              <Button variant="secondary" onClick={() => setHistoryOpen((value) => !value)}>
                {historyOpen ? "Hide reports" : "View all reports"}
              </Button>
            </div>
          </div>
        </Card>
        <Card className="p-5">
          {checkError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{checkError}</p>
          ) : !accessId || !password ? (
            <EmptyState title="Enter report details" body="The result will appear here after both fields are filled." />
          ) : !match && !publicResult ? (
            <EmptyState title="Ready to check" body="Press Check Report to verify the access ID and password." />
          ) : !match && publicResult && !publicResult.found ? (
            <EmptyState title="No matching report" body={publicResult.message ?? "Check the report access ID and password, or contact the clinic."} />
          ) : !match && publicResult && !publicResult.approved ? (
            <div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
                <h3 className="text-xl font-black text-amber-950">Report not made available yet</h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-amber-800">
                  This report is registered, but it cannot be viewed before doctor approval. Please check again after review is complete.
                </p>
              </div>
              {historyOpen ? <PatientReportHistory reports={publicReportHistory} /> : null}
            </div>
          ) : match && match.status !== "approved" ? (
            <div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
                <h3 className="text-xl font-black text-amber-950">Report not made available yet</h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-amber-800">
                  This report is registered, but it cannot be viewed before doctor approval. Please check again after the clinic completes review.
                </p>
              </div>
              {historyOpen ? <PatientReportHistory reports={publicReportHistory} /> : null}
            </div>
          ) : publicReport ? (
            <div>
              <StatusBadge status="approved" />
              <h3 className="mt-3 text-xl font-black text-slate-950">Approved report found</h3>
              <p className="mt-1 text-sm text-slate-500">{publicReport.patientCode} - {publicReport.patientName}</p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Info label="Results" value={patientResult(publicReport.result, publicReport.finalDiagnosis)} />
                <Info label="Approved by" value={doctorDisplayName(publicReport.approvedByName)} />
                <Info label="Approved at" value={publicReport.approvedAt ? new Date(publicReport.approvedAt).toLocaleString() : "-"} />
                <Info label="Access ID" value={publicReport.patientCode} />
              </div>
              <div className="mt-5 space-y-4">
                <ReportSection title="Findings" body={patientSafeReportText(publicReport.findings)} />
                <ReportSection title="Impression" body={patientSafeReportText(publicReport.impression)} />
                <ReportSection title="Recommendation" body={patientSafeReportText(publicReport.recommendation)} />
                <ReportSection title="Doctor Notes" body={patientSafeReportText(publicReport.doctorNotes || "No additional notes.")} />
                <ReportSection title="Final Diagnosis" body={patientResult(publicReport.result, publicReport.finalDiagnosis)} />
              </div>
              <Button className="mt-5" variant="secondary" onClick={() => downloadPublicReportPdf(publicReport)}>
                <Download size={16} />
                Download PDF
              </Button>
              {historyOpen ? <PatientReportHistory reports={publicReportHistory} /> : null}
            </div>
          ) : match ? (
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <StatusBadge status={match.status} />
                  <h3 className="mt-3 text-xl font-black text-slate-950">Approved report found</h3>
                  <p className="mt-1 text-sm text-slate-500">{patient ? getPatientAccessId(patient) : "-"} - {patient?.fullName}</p>
                </div>
                <Button
                  className="w-full sm:w-auto"
                  variant="secondary"
                  onClick={() =>
                    patient
                      ? downloadPublicReportPdf({
                          id: match.id,
                          patientCode: getPatientAccessId(patient),
                          patientName: patient.fullName,
                          age: patient.age,
                          gender: patient.gender,
                          result: patientResult(match.finalDiagnosis, ai?.predictedClass),
                          findings: patientSafeReportText(match.findings),
                          impression: patientSafeReportText(match.impression),
                          recommendation: patientSafeReportText(match.recommendation),
                          doctorNotes: patientSafeReportText(match.doctorNotes),
                          finalDiagnosis: patientResult(match.finalDiagnosis, ai?.predictedClass),
                          approvedByName: doctorDisplayName(localApprover?.fullName),
                          approvedAt: match.approvedAt,
                          createdAt: match.createdAt,
                          status: match.status
                        })
                      : undefined
                  }
                >
                  <Download size={16} />
                  Download PDF
                </Button>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Info label="Results" value={patientResult(match.finalDiagnosis, ai?.predictedClass)} />
                <Info label="Approved by" value={doctorDisplayName(localApprover?.fullName)} />
                <Info label="Approved at" value={match.approvedAt ? new Date(match.approvedAt).toLocaleString() : "-"} />
                <Info label="Access ID" value={patient ? getPatientAccessId(patient) : "-"} />
              </div>
              <div className="mt-5 space-y-4">
                <ReportSection title="Findings" body={patientSafeReportText(match.findings)} />
                <ReportSection title="Impression" body={patientSafeReportText(match.impression)} />
                <ReportSection title="Recommendation" body={patientSafeReportText(match.recommendation)} />
                <ReportSection title="Doctor Notes" body={patientSafeReportText(match.doctorNotes || "No additional notes.")} />
                <ReportSection title="Final Diagnosis" body={patientResult(match.finalDiagnosis, ai?.predictedClass)} />
              </div>
              {historyOpen ? <PatientReportHistory reports={publicReportHistory} /> : null}
            </div>
          ) : (
            <EmptyState title="No matching report" body="Check the report access ID and password, or contact the clinic." />
          )}
        </Card>
      </div>
      {feedbackOpen ? <FeedbackDialog patientCode={accessId} onClose={() => setFeedbackOpen(false)} /> : null}
    </>
  );
}

function PatientReportHistory({ reports }: { reports: PublicReport[] }) {
  return (
    <div className="mt-5 rounded-md border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-black text-slate-950">All patient reports</h3>
        <p className="text-sm font-semibold text-slate-500">{reports.length} report{reports.length === 1 ? "" : "s"}</p>
      </div>
      <div className="mt-4 space-y-3">
        {reports.map((report) => (
          <div key={report.id} className="rounded-md border border-slate-200 bg-white p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
              <div>
                <StatusBadge status={report.status} />
                <p className="mt-2 font-bold text-slate-950">{patientResult(report.result, report.finalDiagnosis)}</p>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  {report.approvedAt || report.createdAt ? new Date(report.approvedAt ?? report.createdAt ?? "").toLocaleString() : "Date unavailable"}
                </p>
              </div>
              <Button className="w-full sm:w-auto" variant="secondary" onClick={() => downloadPublicReportPdf(report)}>
                <Download size={16} />
                Download
              </Button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <ReportSection title="Findings" body={patientSafeReportText(report.findings)} />
              <ReportSection title="Recommendation" body={patientSafeReportText(report.recommendation)} />
            </div>
          </div>
        ))}
        {!reports.length ? <EmptyState title="No past reports" body="Approved, rejected, and superseded reports will appear here after the clinic reviews them." /> : null}
      </div>
    </div>
  );
}

export function FeedbackReviewView({ scope = "admin" }: { scope?: "admin" | "hod" }) {
  const store = useDemoStore();
  const cachedEntries = getCachedFeedbackEntries();
  const [entries, setEntries] = useState<FeedbackEntry[]>(cachedEntries);
  const [filter, setFilter] = useState<"all" | FeedbackEntry["status"]>("all");
  const [tab, setTab] = useState<"inbox" | "messages">("inbox");
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [responseMessage, setResponseMessage] = useState("");
  const [loading, setLoading] = useState(cachedEntries.length === 0);
  const canReview = store.currentUser.role === "admin";
  const visible = entries.filter((entry) => {
    if (tab === "messages" && !(entry.responses?.length)) return false;
    return filter === "all" || entry.status === filter;
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(entries.length === 0);
    getFeedbackEntries()
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch(() => {
        if (!cancelled) setResponseMessage("Could not load feedback from Supabase.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setStatus = async (id: string, status: FeedbackEntry["status"]) => {
    try {
      setEntries(await updateFeedbackStatus(id, status));
    } catch {
      setResponseMessage("Could not update feedback status in Supabase.");
    }
  };

  const sendResponse = async (entry: FeedbackEntry) => {
    const body = responses[entry.id]?.trim();
    if (!body) return;
    try {
      setEntries(await addFeedbackResponse(entry.id, { message: body, responderName: store.currentUser.fullName }));
    } catch {
      setResponseMessage("Could not save the response in Supabase.");
      window.setTimeout(() => setResponseMessage(""), 2500);
      return;
    }
    setResponses((current) => ({ ...current, [entry.id]: "" }));
    setResponseMessage("Response saved.");
    if (entry.email) {
      try {
        const result = await sendFeedbackEmail({
          toEmail: entry.email,
          patientName: entry.name,
          feedbackType: entry.type,
          mode: "response",
          body
        });
        setResponseMessage(result.message);
      } catch {
        setResponseMessage("Response saved, but the email could not be sent automatically.");
      }
    }
    window.setTimeout(() => setResponseMessage(""), 2500);
  };

  if (!canReview) return <Missing title="Access restricted" href="/dashboard" label="Back to dashboard" />;

  return (
    <>
      <PageTitle
        title="Feedback Inbox"
        subtitle="Review feedback and complaints, then reply to patients from the message composer."
      />
      {responseMessage ? <p className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">{responseMessage}</p> : null}
      <div className="mb-5 grid gap-3 lg:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">New feedback</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{entries.filter((entry) => entry.status === "new").length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Messages sent</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{entries.reduce((total, entry) => total + (entry.responses?.length ?? 0), 0)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Resolved</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{entries.filter((entry) => entry.status === "resolved").length}</p>
        </Card>
      </div>
      <Card className="p-5">
        <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
          <div>
            <h3 className="font-black text-slate-950">{tab === "inbox" ? "Feedback and complaints" : "Patient message replies"}</h3>
            <p className="mt-1 text-sm text-slate-500">
              {tab === "inbox" ? "Use status changes to track what has been reviewed." : "Review replies sent from the clinic to patients."}
            </p>
          </div>
          <div className="grid gap-2 sm:flex">
            <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
              <button
                className={`rounded px-3 py-2 text-sm font-bold ${tab === "inbox" ? "bg-white text-clinic-700 shadow-sm" : "text-slate-500"}`}
                onClick={() => setTab("inbox")}
              >
                Inbox
              </button>
              <button
                className={`rounded px-3 py-2 text-sm font-bold ${tab === "messages" ? "bg-white text-clinic-700 shadow-sm" : "text-slate-500"}`}
                onClick={() => setTab("messages")}
              >
                Messages
              </button>
            </div>
            <select className="field sm:w-44" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">All</option>
              <option value="new">New</option>
              <option value="reviewing">Reviewing</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
        </div>
      </Card>
      <div className="mt-5 grid gap-4">
        {visible.map((entry) => (
          <Card key={entry.id} className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">{entry.type}</p>
                <h3 className="mt-1 text-lg font-black text-slate-950">{entry.name}</h3>
                <p className="mt-1 text-sm text-slate-500">{new Date(entry.createdAt).toLocaleString()}</p>
              </div>
              <StatusBadge status={entry.status === "new" ? "pending" : entry.status === "reviewing" ? "pending_review" : "approved"} />
            </div>
            <p className="mt-4 rounded-md bg-slate-50 p-4 text-sm font-semibold leading-6 text-slate-700">{entry.message}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <Info label="Email" value={entry.email || "-"} />
              <Info label="Phone" value={entry.phone || "-"} />
              <Info label="Patient ID" value={entry.patientCode || "-"} />
            </div>
            <div className="mt-4 grid gap-2 sm:flex sm:justify-end">
              <Button className="w-full sm:w-auto" variant="secondary" onClick={() => setStatus(entry.id, "reviewing")}>Mark Reviewing</Button>
              <Button className="w-full sm:w-auto" onClick={() => setStatus(entry.id, "resolved")}>Resolve</Button>
            </div>
            {entry.responses?.length ? (
              <div className="mt-5 space-y-3">
                <h4 className="text-sm font-black uppercase tracking-wide text-slate-500">Message history</h4>
                {entry.responses.map((response) => (
                  <div key={response.id} className="rounded-md border border-slate-200 bg-white p-3">
                    <p className="text-xs font-bold text-slate-500">{response.responderName} | {new Date(response.createdAt).toLocaleString()}</p>
                    <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">{response.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-5 rounded-md border border-slate-200 bg-slate-50 p-4">
              <Textarea
                label="Reply to patient"
                value={responses[entry.id] ?? ""}
                onChange={(value) => setResponses((current) => ({ ...current, [entry.id]: value }))}
              />
              <p className="mt-2 text-xs font-semibold text-slate-500">
                The email will include a polite heading and sign-off automatically. Write the main reply paragraph here.
              </p>
              <Button className="mt-3 w-full sm:w-auto" onClick={() => sendResponse(entry)} disabled={!(responses[entry.id] ?? "").trim()}>
                <MessageSquare size={16} />
                Send Response
              </Button>
            </div>
          </Card>
        ))}
        {loading ? <EmptyState title="Loading feedback" body="Fetching feedback and complaints from Supabase." /> : null}
        {!loading && visible.length === 0 ? <EmptyState title="No feedback found" body="Submitted feedback and complaints will appear here for admin and HOD review." /> : null}
      </div>
    </>
  );
}

export function AdminUsersView() {
  const store = useDemoStore();
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");

  const updateAccess = async (profileId: string, input: { role?: Role; isActive?: boolean }) => {
    setError("");
    setSavingId(profileId);
    try {
      await store.updateProfileAccess(profileId, input);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update user access.");
    } finally {
      setSavingId("");
    }
  };

  return (
    <>
      <PageTitle title="User Access" subtitle="Approve new doctors, assistants, and admin staff before they can enter the workspace." />
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      <div className="space-y-3 md:hidden">
        {store.data.profiles.map((profile) => (
          <Card key={profile.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-black text-slate-950">{profile.fullName}</p>
                <p className="mt-1 break-all text-sm text-slate-500">{profile.email}</p>
              </div>
              <StatusBadge status={profile.isActive ? "active" : "pending"} />
            </div>
            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="label">Role</span>
                <select
                  className="field mt-1 py-2 capitalize"
                  value={profile.role}
                  disabled={savingId === profile.id || profile.email.toLowerCase() === "raahymm@gmail.com"}
                  onChange={(event) => updateAccess(profile.id, { role: event.target.value as Role })}
                >
                  <option value="doctor">Doctor</option>
                  <option value="assistant">Assistant</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <Info label="Doctor ID" value={profile.doctorId ?? "-"} />
              {profile.email.toLowerCase() === "raahymm@gmail.com" ? (
                <span className="rounded-md bg-slate-100 px-3 py-2 text-center text-xs font-bold uppercase text-slate-500">Owner</span>
              ) : profile.isActive ? (
                <Button
                  className="w-full"
                  variant="secondary"
                  disabled={savingId === profile.id}
                  onClick={() => updateAccess(profile.id, { isActive: false })}
                >
                  Suspend Access
                </Button>
              ) : (
                <Button className="w-full" disabled={savingId === profile.id} onClick={() => updateAccess(profile.id, { isActive: true })}>
                  Approve Access
                </Button>
              )}
            </div>
          </Card>
        ))}
        {store.data.profiles.length === 0 ? <EmptyState title="No account requests yet" body="New signup requests will appear here." /> : null}
      </div>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Doctor ID</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {store.data.profiles.map((profile) => (
              <tr key={profile.id}>
                <td className="px-5 py-4 font-bold">{profile.fullName}</td>
                <td className="px-5 py-4">{profile.email}</td>
                <td className="px-5 py-4">
                  <select
                    className="field min-w-32 py-2 capitalize"
                    value={profile.role}
                    disabled={savingId === profile.id || profile.email.toLowerCase() === "raahymm@gmail.com"}
                    onChange={(event) => updateAccess(profile.id, { role: event.target.value as Role })}
                  >
                    <option value="doctor">Doctor</option>
                    <option value="assistant">Assistant</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="px-5 py-4">{profile.doctorId ?? "-"}</td>
                <td className="px-5 py-4"><StatusBadge status={profile.isActive ? "active" : "pending"} /></td>
                <td className="px-5 py-4">
                  {profile.email.toLowerCase() === "raahymm@gmail.com" ? (
                    <span className="text-xs font-bold uppercase text-slate-400">Owner</span>
                  ) : profile.isActive ? (
                    <Button
                      variant="secondary"
                      disabled={savingId === profile.id}
                      onClick={() => updateAccess(profile.id, { isActive: false })}
                    >
                      Suspend
                    </Button>
                  ) : (
                    <Button disabled={savingId === profile.id} onClick={() => updateAccess(profile.id, { isActive: true })}>
                      Approve
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {store.data.profiles.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-center text-sm font-semibold text-slate-500" colSpan={6}>
                  No account requests yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </>
  );
}

export function TemplatesView() {
  const store = useDemoStore();
  const canEditTemplates = store.currentUser.role === "admin" || store.currentUser.role === "doctor";
  const [templates, setTemplates] = useState(reportTemplates);
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [medicine, setMedicine] = useState({
    template: "DME" as DiseaseClass,
    name: "",
    dose: "",
    route: "Oral",
    frequency: "Once daily",
    duration: "",
    instructions: ""
  });

  const updateTemplate = (disease: DiseaseClass, field: "findings" | "impression" | "recommendation", value: string) => {
    setTemplates((current) => ({
      ...current,
      [disease]: {
        ...current[disease],
        [field]: value
      }
    }));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getReportTemplates()
      .then((loadedTemplates) => {
        if (!cancelled) setTemplates(loadedTemplates);
      })
      .catch((err) => {
        if (!cancelled) setSaved(err instanceof Error ? err.message : "Could not load templates from Supabase.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveTemplates = async () => {
    setSaving(true);
    try {
      await saveReportTemplates(templates);
      setSaved("Default report templates saved to Supabase.");
    } catch (err) {
      setSaved(err instanceof Error ? err.message : "Could not save templates to Supabase.");
    } finally {
      setSaving(false);
      window.setTimeout(() => setSaved(""), 2500);
    }
  };

  const resetTemplates = async () => {
    if (!window.confirm("Reset report templates to the original defaults?")) return;
    setTemplates(reportTemplates);
    setSaving(true);
    try {
      await saveReportTemplates(reportTemplates);
      setSaved("Templates reset to defaults in Supabase.");
    } catch (err) {
      setSaved(err instanceof Error ? err.message : "Could not reset templates in Supabase.");
    } finally {
      setSaving(false);
      window.setTimeout(() => setSaved(""), 2500);
    }
  };

  const addMedicineBlock = () => {
    if (!medicine.name.trim()) return;
    const block = [
      "",
      "Prescription / Medicine Plan:",
      `- Medicine: ${medicine.name.trim()}`,
      medicine.dose.trim() ? `- Dose: ${medicine.dose.trim()}` : "",
      `- Route: ${medicine.route}`,
      `- Frequency: ${medicine.frequency}`,
      medicine.duration.trim() ? `- Duration: ${medicine.duration.trim()}` : "",
      medicine.instructions.trim() ? `- Instructions: ${medicine.instructions.trim()}` : "",
      "- Review medicines, allergies, contraindications, and patient history before final approval."
    ].filter(Boolean).join("\n");

    setTemplates((current) => ({
      ...current,
      [medicine.template]: {
        ...current[medicine.template],
        recommendation: `${current[medicine.template].recommendation.trim()}\n${block}`.trim()
      }
    }));
    setMedicine((current) => ({ ...current, name: "", dose: "", duration: "", instructions: "" }));
  };

  if (!canEditTemplates) return <Missing title="Access restricted" href="/dashboard" label="Back to dashboard" />;

  return (
    <>
      <PageTitle
        title="Report Templates"
        subtitle="Edit the default draft text doctors receive when AI-generated reports are created."
        action={
          <div className="grid gap-2 sm:flex">
            <Button className="w-full sm:w-auto" variant="secondary" onClick={resetTemplates} disabled={saving}>Reset Defaults</Button>
            <Button className="w-full sm:w-auto" onClick={saveTemplates} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
              {saving ? "Saving..." : "Save Templates"}
            </Button>
          </div>
        }
      />
      {loading ? <p className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">Loading templates from Supabase...</p> : null}
      {saved ? <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">{saved}</p> : null}
      <Card className="mb-5 p-5">
        <CardHeader title="Prescription Block" subtitle="Add reusable medicine instructions to a disease template without copying patient or hospital details." />
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField
            label="Template"
            value={medicine.template}
            options={diseaseClasses}
            onChange={(value) => setMedicine({ ...medicine, template: value as DiseaseClass })}
          />
          <Field label="Medicine name" value={medicine.name} onChange={(value) => setMedicine({ ...medicine, name: value })} />
          <Field label="Dose" value={medicine.dose} onChange={(value) => setMedicine({ ...medicine, dose: value })} />
          <SelectField
            label="Route"
            value={medicine.route}
            options={["Oral", "Eye drops", "Injection", "Topical", "Other"]}
            onChange={(value) => setMedicine({ ...medicine, route: value })}
          />
          <SelectField
            label="Frequency"
            value={medicine.frequency}
            options={["Once daily", "Twice daily", "Three times daily", "Four times daily", "Once weekly", "As advised"]}
            onChange={(value) => setMedicine({ ...medicine, frequency: value })}
          />
          <Field label="Duration" value={medicine.duration} onChange={(value) => setMedicine({ ...medicine, duration: value })} />
          <Textarea label="Additional instructions" value={medicine.instructions} onChange={(value) => setMedicine({ ...medicine, instructions: value })} />
        </div>
        <Button className="mt-4 w-full sm:w-auto" onClick={addMedicineBlock} disabled={!medicine.name.trim()}>
          <Plus size={16} />
          Add to Template
        </Button>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        {diseaseClasses.map((item) => (
          <Card key={item} className="p-5">
            <h3 className="text-lg font-black text-slate-950">{item}</h3>
            <div className="mt-4 grid gap-4">
              <Textarea label="Findings" value={templates[item].findings} onChange={(value) => updateTemplate(item, "findings", value)} />
              <Textarea label="Impression" value={templates[item].impression} onChange={(value) => updateTemplate(item, "impression", value)} />
              <Textarea
                label="Recommendation / Plan / Prescription"
                minRowsClass="min-h-40"
                value={templates[item].recommendation}
                onChange={(value) => updateTemplate(item, "recommendation", value)}
              />
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

export function AuditLogsView() {
  const store = useDemoStore();
  const loginLogs = store.data.auditLogs.filter((log) => log.action.toLowerCase().includes("login"));
  return (
    <>
      <PageTitle title="Login & Audit History" subtitle="Tracks user logins and clinical workflow actions for accountability." />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Total logs</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.auditLogs.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Login entries</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{loginLogs.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Latest login</p>
          <p className="mt-2 text-sm font-black text-slate-950">
            {loginLogs[0] ? new Date(loginLogs[0].createdAt).toLocaleString() : "-"}
          </p>
        </Card>
      </div>
      <div className="space-y-3 md:hidden">
        {store.data.auditLogs.map((log) => {
          const user = store.data.profiles.find((profile) => profile.id === log.userId);
          return (
            <Card key={log.id} className="p-4">
              <p className="font-black text-slate-950">{log.action}</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Info label="User" value={user?.fullName ?? "Unknown"} />
                <Info label="Record" value={log.recordType || "-"} />
              </div>
              <Info label="Timestamp" value={new Date(log.createdAt).toLocaleString()} />
            </Card>
          );
        })}
        {store.data.auditLogs.length === 0 ? <EmptyState title="No audit logs" body="Workflow actions will appear here." /> : null}
      </div>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-5 py-3">Action</th>
              <th className="px-5 py-3">User</th>
              <th className="px-5 py-3">Record</th>
              <th className="px-5 py-3">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {store.data.auditLogs.map((log) => {
              const user = store.data.profiles.find((profile) => profile.id === log.userId);
              return (
                <tr key={log.id}>
                  <td className="px-5 py-4 font-bold">{log.action}</td>
                  <td className="px-5 py-4">{user?.fullName ?? "Unknown"}</td>
                  <td className="px-5 py-4">{log.recordType}</td>
                  <td className="px-5 py-4">{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ReportRows({ reports }: { reports: Report[] }) {
  const store = useDemoStore();
  if (!reports.length) return <div className="p-5"><EmptyState title="No reports" body="Generated reports will appear here." /></div>;
  return (
    <div className="divide-y divide-slate-100">
      {reports.map((report) => {
        const patient = store.data.patients.find((item) => item.id === report.patientId);
        const ai = store.data.aiResults.find((item) => item.id === report.aiResultId);
        return (
          <div key={report.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto_auto] md:items-center">
            <div>
              <p className="font-bold text-slate-900">{patient?.fullName ?? "Unknown patient"}</p>
              <p className="text-sm text-slate-500">{patient?.patientCode ?? "-"} | AI: {ai?.predictedClass ?? "-"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {patient ? <code className="rounded bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-800">{getPatientCurrentAccessPassword(patient)}</code> : null}
                <button
                  className="inline-flex items-center gap-1 text-xs font-bold text-clinic-700"
                  onClick={() => void navigator.clipboard?.writeText(`Patient access ID: ${patient ? getPatientAccessId(patient) : "-"}\nPassword: ${patient ? getPatientCurrentAccessPassword(patient) : "-"}`)}
                >
                  <Copy size={13} />
                  Copy Access
                </button>
              </div>
            </div>
            <StatusBadge status={report.status} />
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Link href={`/reports/${report.id}/edit`}>
                <Button className="w-full" variant="secondary">Edit</Button>
              </Link>
              <Link href={`/reports/${report.id}/view`}>
                <Button className="w-full" variant="secondary">View</Button>
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PatientTable({ patients, scans, reports }: { patients: Patient[]; scans: { patientId: string; createdAt: string }[]; reports: Report[] }) {
  if (!patients.length) return <div className="p-5"><EmptyState title="No patients found" body="Try a different CNIC or name." /></div>;
  return (
    <>
      <div className="divide-y divide-slate-100 md:hidden">
        {patients.map((patient) => {
          const patientScans = scans.filter((scan) => scan.patientId === patient.id);
          return (
            <div key={patient.id} className="p-4">
              <p className="font-black text-slate-950">{patient.fullName}</p>
              <p className="mt-1 text-sm font-semibold text-clinic-700">{patient.patientCode}</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Info label="Age / Gender" value={`${patient.age} / ${patient.gender}`} />
                <Info label="Reports" value={String(reports.filter((report) => report.patientId === patient.id).length)} />
              </div>
              <Info label="Last scan" value={patientScans[0] ? new Date(patientScans[0].createdAt).toLocaleDateString() : "-"} />
              <Link href={`/patients/${patient.id}`} className="mt-4 block">
                <Button className="w-full" variant="secondary">Open Patient</Button>
              </Link>
            </div>
          );
        })}
      </div>
      <table className="hidden w-full text-left text-sm md:table">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-5 py-3">Patient ID</th>
            <th className="px-5 py-3">Name</th>
            <th className="px-5 py-3">Age/Gender</th>
            <th className="px-5 py-3">Last scan</th>
            <th className="px-5 py-3">Reports</th>
            <th className="px-5 py-3">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {patients.map((patient) => {
            const patientScans = scans.filter((scan) => scan.patientId === patient.id);
            return (
              <tr key={patient.id}>
                <td className="px-5 py-4 font-bold">{patient.patientCode}</td>
                <td className="px-5 py-4">{patient.fullName}</td>
                <td className="px-5 py-4">{patient.age} / {patient.gender}</td>
                <td className="px-5 py-4">{patientScans[0] ? new Date(patientScans[0].createdAt).toLocaleDateString() : "-"}</td>
                <td className="px-5 py-4">{reports.filter((report) => report.patientId === patient.id).length}</td>
                <td className="px-5 py-4">
                  <Link href={`/patients/${patient.id}`}>
                    <Button variant="secondary">Open</Button>
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function FeedbackDialog({
  onClose,
  reportId = "",
  patientCode = ""
}: {
  onClose: () => void;
  reportId?: string;
  patientCode?: string;
}) {
  const [form, setForm] = useState({
    type: "feedback" as FeedbackEntry["type"],
    name: "",
    email: "",
    phone: "",
    patientCode,
    reportId,
    message: ""
  });
  const [registeredId, setRegisteredId] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!form.name || !form.message) return;
    if (form.email && !isValidEmail(form.email)) {
      setSubmitMessage("Enter a valid email address or leave email blank.");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    let entry: FeedbackEntry;
    try {
      entry = await submitFeedback({
        type: form.type,
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        patientCode: form.patientCode || undefined,
        reportId: form.reportId || undefined,
        message: form.message
      });
    } catch (err) {
      setSubmitting(false);
      setSubmitMessage(err instanceof Error ? err.message : "Could not register this request in Supabase. Please try again.");
      return;
    }
    setRegisteredId(entry.id);
    setSubmitting(false);
    if (entry.email) {
      try {
        const result = await sendFeedbackEmail({
          toEmail: entry.email,
          patientName: entry.name,
          feedbackType: entry.type,
          mode: "registered"
        });
        setSubmitMessage(result.message);
      } catch {
        setSubmitMessage("Request registered. Acknowledgement email could not be sent automatically.");
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/45 px-3 py-5 sm:px-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <Card className="mx-auto my-4 max-h-none w-full max-w-xl p-5 sm:my-8">
        {!registeredId ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">Feedback desk</p>
                <h3 className="mt-1 text-xl font-black text-slate-950">Register feedback or complaint</h3>
              </div>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </div>
            <div className="mt-5 grid gap-4 pb-2">
              <SelectField
                label="Type"
                value={form.type}
                options={["feedback", "complaint"]}
                optionLabels={{ feedback: "Feedback", complaint: "Complaint" }}
                onChange={(value) => setForm({ ...form, type: value as FeedbackEntry["type"] })}
              />
              <Field label="Your name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
                <Field label="Phone" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Patient ID optional" value={form.patientCode} onChange={(value) => setForm({ ...form, patientCode: value })} />
                <Field label="Report ID optional" value={form.reportId} onChange={(value) => setForm({ ...form, reportId: value })} />
              </div>
              <Textarea label="Message" minRowsClass="min-h-40" value={form.message} onChange={(value) => setForm({ ...form, message: value })} />
              {submitMessage ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{submitMessage}</p> : null}
              <Button className="w-full" onClick={submit} disabled={!form.name || !form.message || submitting}>
                <Inbox size={16} />
                {submitting ? "Registering..." : "Register"}
              </Button>
            </div>
          </>
        ) : (
          <div className="text-center">
            <CheckCircle2 className="mx-auto text-emerald-600" size={44} />
            <h3 className="mt-4 text-xl font-black text-slate-950">Request registered</h3>
            <p className="mt-2 text-sm font-semibold text-slate-600">Reference ID: {registeredId}</p>
            {submitMessage ? <p className="mt-2 text-sm font-semibold text-slate-600">{submitMessage}</p> : null}
            <Button className="mt-5" onClick={onClose}>Done</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  min,
  max,
  maxLength,
  placeholder
}: {
  label: string;
  value: string;
  type?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="field mt-1" type={type} min={min} max={max} maxLength={maxLength} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  optionLabels,
  onChange
}: {
  label: string;
  value: string;
  options: string[];
  optionLabels?: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="field mt-1" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
  minRowsClass = "min-h-24"
}: {
  label: string;
  value: string;
  minRowsClass?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block md:col-span-2">
      <span className="label">{label}</span>
      <textarea className={`field mt-1 ${minRowsClass} resize-y`} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-4">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Probability({ label, value, active }: { label: string; value: number; active: boolean }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="font-bold text-slate-700">{label}</span>
        <span className="font-semibold text-slate-500">{Math.round(value * 100)}%</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div className={active ? "h-2 rounded-full bg-clinic-600" : "h-2 rounded-full bg-slate-300"} style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
    </div>
  );
}

function ReportSection({ title, body }: { title: string; body: string }) {
  return (
    <section className="mt-4">
      <h4 className="text-sm font-black uppercase tracking-wide text-slate-500">{title}</h4>
      <p className="mt-2 leading-7 text-slate-800">{body}</p>
    </section>
  );
}

function Missing({ title, href, label }: { title: string; href: string; label: string }) {
  return (
    <Card className="p-6">
      <EmptyState title={title} body="The selected record could not be found for the current account." />
      <Link href={href} className="mt-4 inline-flex">
        <Button variant="secondary">{label}</Button>
      </Link>
    </Card>
  );
}
