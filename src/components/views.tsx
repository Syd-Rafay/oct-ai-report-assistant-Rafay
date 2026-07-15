"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
  LockKeyhole,
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
import { predictOCTWithGradcam, predictRetina, predictVKG, type RetinaServiceSelection } from "@/lib/ai-api";
import { useDemoStore } from "@/lib/demo-store";
import { addFeedbackResponse, getCachedFeedbackEntries, getFeedbackEntries, submitFeedback, updateFeedbackStatus } from "@/lib/feedback";
import { prepareScanImages } from "@/lib/image-processing";
import { getModulesByIds } from "@/lib/modules";
import { downloadPublicReportPdf, downloadReportPdf } from "@/lib/pdf";
import { changePatientAccessPassword, checkPublicReport, getPatientAccessId, getPatientCurrentAccessPassword, sendFeedbackEmail, sendReportAccessEmail, type PublicReport, type PublicReportResult } from "@/lib/report-access";
import { getReportTemplates, reportClassesForModule, reportTemplates, saveReportTemplates } from "@/lib/report-templates";
import { supabase } from "@/lib/supabase";
import type { AiResult, BusinessPermissionKey, BusinessPermissions, ClinicalClass, DiseaseClass, EyeSide, FeedbackEntry, Gender, ModuleId, Patient, Report, Role, Scan } from "@/lib/types";

const diseaseClasses: DiseaseClass[] = ["CNV", "DME", "DRUSEN", "NORMAL"];
const vkgClasses: ClinicalClass[] = ["NORMAL", "KCN", "SUSPECT"];
const retinaClasses: ClinicalClass[] = ["NO_DR", "MILD_DR", "MODERATE_DR", "SEVERE_DR", "PROLIFERATIVE_DR"];

const MIN_PATIENT_AGE = 0;
const MAX_PATIENT_AGE = 130;

type RetinaDetails = {
  selected?: RetinaServiceSelection;
  dr?: {
    class?: string;
    confidence?: number;
    low_confidence?: boolean;
    referral?: string;
    probabilities?: Partial<Record<ClinicalClass, number>>;
  } | null;
  glaucoma?: {
    risk?: string;
    cdr?: number | string;
    confidence?: number | string;
    disc_pixels?: number | string;
    cup_pixels?: number | string;
    detail?: string;
  } | null;
  hypertensive_retinopathy?: {
    detected?: boolean | string;
    risk?: string;
    probability?: number | string;
    recommendation?: string;
    threshold?: number;
  } | null;
  warnings?: string[];
};

function parseRetinaModelVersion(modelVersion: string): { details?: RetinaDetails; displayVersion: string } {
  const prefix = "retina-details:";
  if (!modelVersion.startsWith(prefix)) return { displayVersion: modelVersion };
  const separator = " | ";
  const end = modelVersion.indexOf(separator);
  const jsonText = end === -1 ? modelVersion.slice(prefix.length) : modelVersion.slice(prefix.length, end);
  try {
    return {
      details: JSON.parse(jsonText) as RetinaDetails,
      displayVersion: end === -1 ? "Retina combined screening" : modelVersion.slice(end + separator.length)
    };
  } catch {
    return { displayVersion: modelVersion.replace(/^retina-details:[^|]+\s\|\s?/, "") };
  }
}

function formatMaybePercent(value: number | string | undefined) {
  if (typeof value !== "number") return value ? String(value) : "Not available";
  return `${Math.round(value * 100)}%`;
}

function imageDisplaySource(value?: string) {
  if (!value) return "";
  if (value.startsWith("data:image/") || value.startsWith("http://") || value.startsWith("https://")) return value;
  return `data:image/png;base64,${value}`;
}

function RetinaServiceSelector({
  value,
  onChange,
  disabled
}: {
  value: RetinaServiceSelection;
  onChange: (value: RetinaServiceSelection) => void;
  disabled?: boolean;
}) {
  const items: Array<[keyof RetinaServiceSelection, string]> = [
    ["dr", "DR Severity"],
    ["glaucoma", "Glaucoma CDR"],
    ["hr", "Hypertensive Retinopathy"],
  ];
  const setItem = (key: keyof RetinaServiceSelection, checked: boolean) => {
    const next = { ...value, [key]: checked };
    onChange(next);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Run Retina Models</p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ dr: true, glaucoma: true, hr: true })}
          className="text-xs font-black text-clinic-700 disabled:opacity-50"
        >
          Select all
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {items.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-800">
            <input
              type="checkbox"
              checked={value[key]}
              disabled={disabled}
              onChange={(event) => setItem(key, event.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}

function RetinaResultDetails({ aiResult, activeTab, onTabChange }: { aiResult: AiResult; activeTab: "summary" | "dr" | "glaucoma" | "hr"; onTabChange: (tab: "summary" | "dr" | "glaucoma" | "hr") => void }) {
  const { details } = parseRetinaModelVersion(aiResult.modelVersion);
  if (!details) return null;
  const glaucoma = details.glaucoma;
  const hr = details.hypertensive_retinopathy;
  const hrDetected = hr?.detected === true || hr?.detected === "true";
  const dr = details.dr;
  const selectedCount = Object.values(details.selected ?? { dr: true, glaucoma: true, hr: true }).filter(Boolean).length;
  const headline =
    hrDetected ? "Hypertensive retinopathy flagged"
      : glaucoma?.risk && !/not run/i.test(glaucoma.risk) ? glaucoma.risk
      : dr?.class ? dr.class
      : "Retina screening complete";
  const tabs: Array<["summary" | "dr" | "glaucoma" | "hr", string, boolean]> = [
    ["summary", "Combined Summary", true],
    ["dr", "DR Severity", Boolean(details.selected?.dr ?? dr)],
    ["glaucoma", "Glaucoma CDR", Boolean(details.selected?.glaucoma ?? glaucoma)],
    ["hr", "Hypertensive Retinopathy", Boolean(details.selected?.hr ?? hr)],
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-clinic-100 bg-clinic-50/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-clinic-700">Combined Retina Summary</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{headline}</p>
            <p className="mt-1 text-sm font-semibold text-slate-600">{selectedCount} selected model{selectedCount === 1 ? "" : "s"} completed or attempted.</p>
          </div>
          {details.warnings?.length ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">Review flag</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {tabs.map(([tab, label, enabled]) => (
          <button
            key={tab}
            type="button"
            disabled={!enabled}
            onClick={() => onTabChange(tab)}
            className={`rounded-md border px-3 py-2 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${
              activeTab === tab ? "border-clinic-500 bg-clinic-50 text-clinic-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === "summary" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniRetinaMetric label="DR" value={dr?.class ?? "Not run"} sub={dr ? `Confidence ${formatMaybePercent(dr.confidence ?? aiResult.confidence)}` : "Not selected"} />
          <MiniRetinaMetric label="Glaucoma" value={glaucoma?.risk || "Not run"} sub={glaucoma ? `CDR ${typeof glaucoma.cdr === "number" ? glaucoma.cdr.toFixed(3) : glaucoma.cdr || "N/A"}` : "Not selected"} />
          <MiniRetinaMetric label="HR" value={hr?.risk || (hr ? "No HR Detected" : "Not run")} sub={hr ? `Probability ${formatMaybePercent(typeof hr.probability === "number" ? hr.probability : undefined)}` : "Not selected"} danger={hrDetected} />
        </div>
      ) : null}
      {activeTab === "dr" ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-slate-500">Diabetic Retinopathy</p>
              <p className="mt-1 text-2xl font-black text-slate-950">{dr?.class ?? "Not run"}</p>
              <p className="text-sm font-semibold text-slate-600">Confidence {formatMaybePercent(dr?.confidence ?? aiResult.confidence)}</p>
            </div>
            {dr?.low_confidence ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">Low confidence</span> : null}
          </div>
          {dr?.referral ? <p className="mt-3 text-sm leading-relaxed text-slate-600">{dr.referral}</p> : null}
          <div className="mt-4 space-y-3">
            {retinaClasses.map((item) => (
              <Probability key={item} label={item} value={dr?.probabilities?.[item] ?? aiResult.probabilities[item] ?? 0} active={item === dr?.class} />
            ))}
          </div>
        </div>
      ) : null}
      {activeTab === "glaucoma" ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wide text-slate-500">Glaucoma CDR Screening</p>
          <p className="mt-1 text-2xl font-black text-slate-950">{glaucoma?.risk || "Not run"}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <Info label="CDR" value={typeof glaucoma?.cdr === "number" ? glaucoma.cdr.toFixed(3) : glaucoma?.cdr ? String(glaucoma.cdr) : "N/A"} />
            <Info label="Confidence" value={formatMaybePercent(typeof glaucoma?.confidence === "number" ? glaucoma.confidence : undefined)} />
            <Info label="Disc pixels" value={glaucoma?.disc_pixels ? String(glaucoma.disc_pixels) : "N/A"} />
            <Info label="Cup pixels" value={glaucoma?.cup_pixels ? String(glaucoma.cup_pixels) : "N/A"} />
          </div>
          {glaucoma?.detail ? <p className="mt-3 text-sm leading-relaxed text-slate-600">{glaucoma.detail}</p> : null}
        </div>
      ) : null}
      {activeTab === "hr" ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wide text-slate-500">Hypertensive Retinopathy</p>
          <p className={`mt-1 text-2xl font-black ${hrDetected ? "text-red-700" : "text-slate-950"}`}>{hr?.risk || (hr ? "No HR Detected" : "Not run")}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Info label="Probability" value={formatMaybePercent(typeof hr?.probability === "number" ? hr.probability : undefined)} />
            <Info label="Threshold" value={formatMaybePercent(hr?.threshold ?? 0.2)} />
            <Info label="Detected" value={hrDetected ? "Yes" : hr ? "No" : "N/A"} />
          </div>
          {hr?.recommendation ? <p className="mt-3 text-sm leading-relaxed text-slate-600">{hr.recommendation}</p> : null}
        </div>
      ) : null}
      <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer text-sm font-black text-slate-800">Advanced details, warnings, Grad-CAM status</summary>
        <div className="mt-3 space-y-2 text-xs font-semibold leading-relaxed text-slate-600">
          {details.warnings?.length ? <p>{details.warnings.join(" ")}</p> : <p>No extra quality warnings recorded.</p>}
          <p>Grad-CAM: {aiResult.heatmapUrl ? "Available for this analysis." : "Not returned by the deployed DR service for this run."}</p>
        </div>
      </details>
    </div>
  );
}

function MiniRetinaMetric({ label, value, sub, danger }: { label: string; value: string; sub: string; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-black uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-black ${danger ? "text-red-700" : "text-slate-950"}`}>{value}</p>
      <p className="text-xs font-semibold text-slate-500">{sub}</p>
    </div>
  );
}

function CleanModelVersion({ aiResult }: { aiResult: AiResult }) {
  const { displayVersion } = parseRetinaModelVersion(aiResult.modelVersion);
  return <Info label="Model" value={`${aiResult.modelName} ${displayVersion}`} />;
}

function moduleFromSearchParams(searchParams: ReturnType<typeof useSearchParams>): ModuleId {
  const moduleId = searchParams.get("module");
  return moduleId === "vkg" || moduleId === "retina" || moduleId === "corneal" ? moduleId : "oct";
}

function getModuleLabel(moduleId: ModuleId) {
  if (moduleId === "vkg") return "VKG";
  if (moduleId === "retina") return "Retina";
  if (moduleId === "corneal") return "Corneal";
  return "OCT";
}

function reportHistoryHref(moduleId?: ModuleId) {
  const resolvedModuleId = moduleId ?? "oct";
  return resolvedModuleId === "oct" ? "/reports/history?module=oct" : `/reports/history?module=${resolvedModuleId}`;
}

function filterPatientsForModule(patients: Patient[], scans: Scan[], moduleId: ModuleId) {
  const patientIdsWithModuleScans = new Set(scans.filter((scan) => (scan.moduleId ?? "oct") === moduleId).map((scan) => scan.patientId));
  return patients.filter((patient) => {
    if (patientIdsWithModuleScans.has(patient.id)) return true;
    if (patient.moduleId) return patient.moduleId === moduleId;
    return moduleId === "oct";
  });
}

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
    .replace(/AI model output/gi, "Clinical result")
    .replace(/AI model/gi, "screening system")
    .replace(/AI-screening features/gi, "screening features")
    .replace(/AI classification/gi, "screening result")
    .replace(/AI-assisted classification suggests/gi, "Doctor-reviewed results show")
    .replace(/based on AI-assisted analysis/gi, "after doctor review")
    .replace(/AI-assisted fundus screening suggests/gi, "Doctor-reviewed fundus screening shows")
    .replace(/AI-assisted VKG screening suggests/gi, "Doctor-reviewed VKG screening shows")
    .replace(/AI-assisted/g, "Doctor-reviewed")
    .replace(/\bAI\b/g, "clinical")
    .replace(/\bConfidence:\s*\d+%/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const [hospitalId, setHospitalId] = useState("");
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
    if (password.length < 8) {
      setError(authMode === "signup" ? "Password must be at least 8 characters." : "Enter your account password.");
      return;
    }
    setLoading(true);
    try {
      if (authMode === "signup") {
        if (!fullName.trim()) {
          setError("Enter your full name.");
          setLoading(false);
          return;
        }
        if (!hospitalId) {
          setError("Select your registered hospital.");
          setLoading(false);
          return;
        }
        await store.signUp({
          email,
          password,
          fullName: fullName || email.split("@")[0],
          role: requestedRole,
          hospitalId,
          department: "",
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
      <section className="hidden h-screen bg-[linear-gradient(135deg,#0f6170,#2563eb)] px-14 py-16 text-white lg:sticky lg:top-0 lg:flex lg:flex-col lg:justify-center">
        <div className="max-w-4xl -translate-y-4">
          <p className="mb-8 text-sm font-bold uppercase tracking-[0.18em] text-white/70">AFIO Clinical Platform</p>
          <h1 className="max-w-xl text-4xl font-black leading-tight">Clinical workflow system for ophthalmology.</h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-white/82">
            Open licensed diagnostic modules, keep department records separated, and route each report through doctor review.
          </p>
          <div className="mt-16 grid max-w-3xl grid-cols-2 gap-3 text-sm">
            {["Licensed modules", "Separate departments", "Doctor review", "Approved reports"].map((item) => (
              <div key={item} className="rounded-lg border border-white/14 bg-white/10 p-4 font-bold backdrop-blur">{item}</div>
            ))}
          </div>
        </div>
      </section>
      <section className={`flex min-h-screen justify-center px-5 py-6 ${authMode === "signup" ? "items-start" : "items-center"}`}>
        <Card className="w-full max-w-md p-6">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-clinic-700">AFIO secure access</p>
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
                : "Request access for your hospital role. Accounts stay locked until administrator approval."}
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
              <input className="field mt-1" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="field mt-1"
                type="password"
                autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {authMode === "signup" ? (
              <>
                <div>
                  <label className="label">Full name</label>
                  <input className="field mt-1" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} />
                </div>
                <div>
                  <label className="label">Role requested</label>
                  <select className="field mt-1" value={requestedRole} onChange={(event) => setRequestedRole(event.target.value as Role)}>
                    <option value="doctor">Doctor</option>
                    <option value="assistant">Assistant / Technician</option>
                    <option value="hospital_admin">Hospital Admin / Records Staff</option>
                  </select>
                </div>
                <div>
                  <label className="label">Registered hospital</label>
                  <select className="field mt-1" value={hospitalId} onChange={(event) => setHospitalId(event.target.value)}>
                    <option value="">Select hospital</option>
                    {store.signupHospitals.map((hospital) => (
                      <option key={hospital.id} value={hospital.id}>{hospital.name}</option>
                    ))}
                  </select>
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
            <Button className="w-full" onClick={submit} disabled={loading || !email || !password || (authMode === "signup" && (!fullName.trim() || !hospitalId))}>
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
    if (!isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
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
          <input className="field" type="email" autoComplete="email" placeholder="doctor@clinic.com" value={email} onChange={(event) => setEmail(event.target.value)} />
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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function prepareRecoverySession() {
      if (!supabase) {
        setError("Supabase is not configured.");
        setReady(true);
        return;
      }

      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        const type = hashParams.get("type");

        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
          window.history.replaceState({}, document.title, "/reset-password");
        } else if (accessToken && refreshToken && type === "recovery") {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
          });
          if (sessionError) throw sessionError;
          window.history.replaceState({}, document.title, "/reset-password");
        } else {
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            setError("Open this page from the password reset email link, then enter a new password.");
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not verify the password reset link.");
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void prepareRecoverySession();
    return () => {
      cancelled = true;
    };
  }, []);

  const updatePassword = async () => {
    setError("");
    setMessage("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
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
          <input className="field" type="password" autoComplete="new-password" placeholder="New password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <input className="field" type="password" autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          <Button className="w-full" onClick={updatePassword} disabled={!ready || loading || !password || !confirmPassword}>
            {loading ? <Loader2 className="animate-spin" size={16} /> : null}
            {ready ? "Update password" : "Checking reset link..."}
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
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
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
    <main className="flex min-h-screen items-start justify-center bg-slate-50 px-5 py-8 sm:items-center">
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
  const visibleModuleIds = new Set(store.visibleModuleIds);
  const platformModules = [
    {
      id: "oct",
      enabled: visibleModuleIds.has("oct"),
      title: "OCT",
      owner: "OCT SERVICE",
      route: "/modules/oct",
      status: "Live",
      summary: "OCT patients, image uploads, screening results, doctor review, and approved reports."
    },
    {
      id: "vkg",
      enabled: visibleModuleIds.has("vkg"),
      title: "VKG",
      owner: "VKG SERVICE",
      route: "/modules/vkg",
      status: "Live",
      summary: "VKG/topography patients, screening workflow, draft reports, templates, and separate report history."
    },
    {
      id: "corneal",
      enabled: visibleModuleIds.has("corneal"),
      title: "Corneal / VKG Detection",
      owner: "CORNEAL SERVICE",
      route: "/modules/corneal",
      status: "Model ready",
      summary: "Keratoconus/corneal screening engine exposed as a separate API and report result module.",
      accessHint: "Enable from Business Admin after purchase."
    },
    {
      id: "retina",
      enabled: visibleModuleIds.has("retina"),
      title: "Retinal Fundus Screening",
      owner: "RETINA SERVICE",
      route: "/modules/retina",
      status: "Live",
      summary: "Fundus screening for diabetic retinopathy, glaucoma risk, and hypertensive retinopathy with patient records and reports.",
      accessHint: "Enable after the hospital purchases Retina access."
    }
  ];
  const visibleModules = store.currentUser.role === "afio_admin" ? platformModules : platformModules.filter((module) => module.enabled);
  const enabledCount = visibleModules.filter((module) => module.enabled).length;
  const hospital = store.currentHospital;
  const dashboardTitle = store.currentUser.role === "afio_admin"
    ? "AFIO Platform Dashboard"
    : `${hospital?.name ?? store.currentUser.clinicName ?? "Hospital"} Dashboard`;
  return (
    <>
      <PageTitle
        title={dashboardTitle}
        subtitle={store.currentUser.role === "afio_admin" ? "Business Admin preview. Hospitals only see services enabled from the business control panel." : "Choose one of your hospital's purchased services. Patients, reports, feedback, and storage remain scoped to the selected hospital."}
      />
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Enabled modules</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{enabledCount}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Total patients</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.patients.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Subscription</p>
          <p className="mt-2 text-3xl font-black capitalize text-slate-950">{hospital?.subscriptionStatus ?? "AFIO"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Clinic workspace</p>
          <p className="mt-2 text-lg font-black text-slate-950">{hospital?.name ?? store.currentUser.clinicName ?? "AFIO Platform"}</p>
        </Card>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {visibleModules.map((module) => {
          return (
            <Card key={module.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase text-slate-500">{module.owner}</p>
                  <h3 className="mt-1 text-xl font-black text-slate-950">{module.title}</h3>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-black ${module.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                  {module.enabled ? "Enabled" : "Locked"}
                </span>
              </div>
              <p className="mt-4 min-h-24 text-sm leading-6 text-slate-600">{module.summary}</p>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <span className="text-xs font-black uppercase text-slate-500">{module.status}</span>
                {module.enabled ? (
                  <Link href={module.route}>
                    <Button variant="secondary">Open Module</Button>
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm font-bold text-slate-400">
                    <LockKeyhole size={14} />
                    Not enabled
                  </span>
                )}
              </div>
              {store.currentUser.role === "afio_admin" && !module.enabled ? <p className="mt-3 text-xs font-semibold text-slate-500">{module.accessHint}</p> : null}
            </Card>
          );
        })}
        {visibleModules.length === 0 ? <EmptyState title="No modules enabled" body="Ask the hospital admin or AFIO business admin to enable a purchased service." /> : null}
      </div>

      <div className="mt-5 grid gap-5">
        <Card className="p-5">
          <CardHeader title="How hospital access works" subtitle="Access is managed from Business Admin, not by doctors entering module keys." />
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ["1", "Hospital is registered", "Business Admin creates Shifa, Al Noor, or another hospital."],
              ["2", "Services are enabled", "Business Admin gives or removes OCT, VKG, Corneal, or Retina access."],
              ["3", "Clinical data is scoped", "Patients, reports, storage paths, and feedback stay under that hospital."]
            ].map(([step, title, body]) => (
              <div key={step} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-black text-clinic-700">STEP {step}</p>
                <p className="mt-2 font-black text-slate-950">{title}</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">{body}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

export function OctModuleView() {
  const store = useDemoStore();
  const [feedbackCount, setFeedbackCount] = useState(0);
  const octScans = store.data.scans.filter((scan) => (scan.moduleId ?? "oct") === "oct");
  const octReports = store.data.reports.filter((report) => (report.moduleId ?? "oct") === "oct");
  const octPatientIds = new Set(octScans.map((scan) => scan.patientId));
  const octPatients = store.data.patients.filter((patient) => octPatientIds.has(patient.id) || !patient.departmentId);
  const pending = octReports.filter((report) => report.status !== "approved").length;
  const approved = octReports.filter((report) => report.status === "approved").length;
  const today = new Date().toISOString().slice(0, 10);
  const todayReports = octReports.filter((report) => report.createdAt.startsWith(today)).length;
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
    ["OCT patients", octPatients.length],
    ["OCT tests", octScans.length],
    ["Pending reports", pending],
    ["Approved reports", approved],
    ["Reports today", todayReports],
    ["Hospital feedback", feedbackCount]
  ];
  return (
    <>
      <PageTitle
        title="OCT"
        subtitle="OCT workflow for patients, tests, screening results, doctor review, and PDF delivery."
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
                Reports
              </Button>
            </Link>
          </div>
        }
      />
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
          <CardHeader title="Recent OCT Patients" subtitle="Open a patient profile to view tests and reports." />
          <div className="divide-y divide-slate-100">
            {octPatients.slice(0, 5).map((patient) => (
              <Link key={patient.id} href={`/patients/${patient.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
                <div>
                  <p className="font-bold text-slate-900">{patient.fullName}</p>
                  <p className="text-sm text-slate-500">{patient.patientCode}</p>
                </div>
                <p className="text-sm font-semibold text-clinic-700">Open</p>
              </Link>
            ))}
            {octPatients.length === 0 ? <EmptyState title="No OCT patients yet" body="Create a patient or upload the first OCT test." /> : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent OCT Reports" subtitle="Draft, pending, and approved reports for OCT." />
          <ReportRows reports={octReports.slice(0, 5)} />
        </Card>
      </div>
    </>
  );
}

export function VkgModuleView() {
  const store = useDemoStore();
  const vkgScans = store.data.scans.filter((scan) => scan.moduleId === "vkg" || scan.scanType === "VKG");
  const vkgReports = store.data.reports.filter((report) => report.moduleId === "vkg");
  const vkgPatientIds = new Set(vkgScans.map((scan) => scan.patientId));
  const vkgPatients = store.data.patients.filter((patient) => vkgPatientIds.has(patient.id));
  const pending = vkgReports.filter((report) => report.status !== "approved").length;
  const approved = vkgReports.filter((report) => report.status === "approved").length;
  const today = new Date().toISOString().slice(0, 10);
  const todayReports = vkgReports.filter((report) => report.createdAt.startsWith(today)).length;
  const stats = [
    ["VKG patients", vkgPatients.length],
    ["VKG tests", vkgScans.length],
    ["Pending reports", pending],
    ["Approved reports", approved],
    ["Reports today", todayReports]
  ];
  return (
    <>
      <PageTitle
        title="VKG"
        subtitle="VKG/topography screening workflow with separate patients, scans, report templates, and reports."
        action={
          <div className="grid gap-2 sm:flex">
            <Link href="/patients/new?module=vkg" className="block">
              <Button className="w-full">
                <Plus size={16} />
                New Patient
              </Button>
            </Link>
            <Link href="/scans/upload?module=vkg" className="block">
              <Button className="w-full" variant="secondary">
                <Upload size={16} />
                Upload VKG
              </Button>
            </Link>
            <Link href="/reports/history?module=vkg" className="block">
              <Button className="w-full" variant="secondary">
                <ClipboardCheck size={16} />
                Reports
              </Button>
            </Link>
          </div>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map(([label, value]) => (
          <Card key={label} className="p-5">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
          </Card>
        ))}
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent VKG Patients" subtitle="Open a patient profile to view VKG tests and reports." />
          <div className="divide-y divide-slate-100">
            {vkgPatients.slice(0, 5).map((patient) => (
              <Link key={patient.id} href={`/patients/${patient.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
                <div>
                  <p className="font-bold text-slate-900">{patient.fullName}</p>
                  <p className="text-sm text-slate-500">{patient.patientCode}</p>
                </div>
                <p className="text-sm font-semibold text-clinic-700">Open</p>
              </Link>
            ))}
            {vkgPatients.length === 0 ? <EmptyState title="No VKG patients yet" body="Create a patient or upload the first VKG/topography scan." /> : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent VKG Reports" subtitle="No OCT reports appear here." />
          <ReportRows reports={vkgReports.slice(0, 5)} />
        </Card>
      </div>
    </>
  );
}

export function RetinaModuleView() {
  const store = useDemoStore();
  const [activeTab, setActiveTab] = useState<"dr" | "glaucoma" | "hr">("dr");
  const retinaScans = store.data.scans.filter((scan) => (scan.moduleId ?? "oct") === "retina");
  const retinaReports = store.data.reports.filter((report) => (report.moduleId ?? "oct") === "retina");
  const retinaPatientIds = new Set(retinaScans.map((scan) => scan.patientId));
  const retinaPatients = store.data.patients.filter((patient) => retinaPatientIds.has(patient.id) || patient.moduleId === "retina");
  const tabs = [
    {
      id: "dr",
      label: "Diabetic Retinopathy",
      endpoint: "/predict",
      model: "DR severity ONNX + optional Grad-CAM",
      classes: "No DR, Mild, Moderate, Severe, Proliferative",
      output: "Severity, confidence, referral guidance, heatmap when model weights are present."
    },
    {
      id: "glaucoma",
      label: "Glaucoma",
      endpoint: "/predict-glaucoma",
      model: "Optic disc/cup segmentation ONNX",
      classes: "Normal, Monitor, Suspicious, High risk",
      output: "Cup-to-disc ratio, risk level, disc/cup pixel counts."
    },
    {
      id: "hr",
      label: "Hypertensive Retinopathy",
      endpoint: "/predict-hr",
      model: "EfficientNet ONNX binary classifier",
      classes: "No HR Detected, HR Detected",
      output: "Probability, risk label, referral recommendation."
    }
  ] as const;
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <>
      <PageTitle
        title="Retinal Fundus Screening"
        subtitle="Fundus workflow for DR severity, glaucoma risk, and hypertensive retinopathy screening."
        action={
          <div className="grid gap-2 sm:flex">
            <Link href="/patients/new?module=retina" className="block">
              <Button className="w-full">
                <Plus size={16} />
                New Patient
              </Button>
            </Link>
            <Link href="/scans/upload?module=retina" className="block">
              <Button className="w-full" variant="secondary">
                <Upload size={16} />
                Upload Fundus
              </Button>
            </Link>
            <Link href="/reports/history?module=retina" className="block">
              <Button className="w-full" variant="secondary">
                <ClipboardCheck size={16} />
                Reports
              </Button>
            </Link>
          </div>
        }
      />
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Retina patients", retinaPatients.length],
          ["Fundus scans", retinaScans.length],
          ["Reports", retinaReports.length],
          ["Screening checks", 3],
          ["Status", "Live"]
        ].map(([label, value]) => (
          <Card key={label} className="p-5">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-5 p-5">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`rounded-md border px-3 py-2 text-sm font-black ${activeTab === tab.id ? "border-clinic-200 bg-clinic-50 text-clinic-800" : "border-slate-200 bg-white text-slate-600"}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_360px]">
          <div>
            <p className="text-xs font-black uppercase text-slate-500">{active.endpoint}</p>
            <h3 className="mt-1 text-xl font-black text-slate-950">{active.label}</h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">{active.output}</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Info label="Model" value={active.model} />
              <Info label="Classes" value={active.classes} />
            </div>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-black text-slate-950">Screening workflow</p>
            <p className="mt-2 leading-6">
              One fundus upload prepares diabetic-retinopathy severity, glaucoma risk, and hypertensive-retinopathy findings for doctor review.
            </p>
          </div>
        </div>
      </Card>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent Retina Patients" />
          <div className="divide-y divide-slate-100">
            {retinaPatients.slice(0, 5).map((patient) => (
              <Link key={patient.id} href={`/patients/${patient.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
                <div>
                  <p className="font-bold text-slate-900">{patient.fullName}</p>
                  <p className="text-sm text-slate-500">{patient.patientCode}</p>
                </div>
                <p className="text-sm font-semibold text-clinic-700">Open</p>
              </Link>
            ))}
            {retinaPatients.length === 0 ? <EmptyState title="No retina patients yet" body="Create a retina patient before uploading fundus images." /> : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent Retina Reports" subtitle="Draft, pending, and approved reports generated from fundus screening." />
          <ReportRows reports={retinaReports.slice(0, 5)} />
        </Card>
      </div>
    </>
  );
}

export function LockedModuleView({ moduleName, owner, description }: { moduleName: string; owner: string; description: string }) {
  return (
    <>
      <PageTitle title={moduleName} subtitle={`${owner} module. Access is controlled by hospital subscription in Business Admin.`} />
      <div className="grid gap-5">
        <Card className="p-5">
          <CardHeader title="Module locked" subtitle={description} />
          <div className="grid gap-3 md:grid-cols-3">
            {["Separate patients", "Separate reports", "Separate feedback"].map((item) => (
              <div key={item} className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm font-bold text-slate-700">{item}</div>
            ))}
          </div>
          <p className="mt-5 text-sm leading-6 text-slate-600">
            When this module is enabled from Business Admin, its own patient list, upload flow, result page, report templates, and feedback inbox will be scoped by hospital.
          </p>
        </Card>
      </div>
    </>
  );
}

export function AfioBusinessMembersView() {
  const store = useDemoStore();
  const [error, setError] = useState("");
  const permissionKeys: BusinessPermissionKey[] = ["manage_members", "add_hospitals", "edit_hospitals", "suspend_hospitals", "manage_modules", "delete_hospitals"];
  const permissionLabels: Record<BusinessPermissionKey, string> = {
    manage_members: "Invite/manage AFIO members",
    add_hospitals: "Add hospitals",
    edit_hospitals: "Edit hospital details",
    suspend_hospitals: "Suspend/enable hospitals",
    manage_modules: "Grant models/modules",
    delete_hospitals: "Delete hospitals"
  };
  const ownerEmail = "raahymm@gmail.com";
  const isOwner = store.currentUser.role === "afio_admin" && store.currentUser.email.toLowerCase() === ownerEmail;
  const hasBusinessPermission = (key: BusinessPermissionKey) => isOwner || store.currentUser.businessPermissions?.[key] === true;
  const [memberInvite, setMemberInvite] = useState({
    email: "",
    fullName: "",
    permissions: {
      add_hospitals: true,
      edit_hospitals: true,
      suspend_hospitals: false,
      manage_modules: false,
      delete_hospitals: false,
      manage_members: false
    } as BusinessPermissions
  });
  const [memberResult, setMemberResult] = useState<{ email: string; temporaryPassword: string; emailSent: boolean; emailMessage?: string } | null>(null);
  const [savingMemberId, setSavingMemberId] = useState("");
  const businessMembers = store.data.profiles.filter((profile) => profile.role === "afio_admin");

  const inviteMember = async () => {
    setError("");
    setMemberResult(null);
    setSavingMemberId("new");
    try {
      const result = await store.inviteBusinessMember(memberInvite);
      setMemberResult({
        email: result.profile.email,
        temporaryPassword: result.temporaryPassword,
        emailSent: result.emailSent,
        emailMessage: result.emailMessage
      });
      setMemberInvite({ email: "", fullName: "", permissions: memberInvite.permissions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not invite business member.");
    } finally {
      setSavingMemberId("");
    }
  };

  const updateMemberPermission = async (profileId: string, permissions: BusinessPermissions) => {
    setError("");
    setSavingMemberId(profileId);
    try {
      await store.updateBusinessMemberPermissions(profileId, permissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update business member permissions.");
    } finally {
      setSavingMemberId("");
    }
  };

  if (store.currentUser.role !== "afio_admin") {
    return <EmptyState title="AFIO members only" body="Only AFIO Business Admin accounts can manage internal AFIO members." />;
  }

  return (
    <>
      <PageTitle title="AFIO Members" subtitle="Invite internal AFIO staff and control what business actions they can perform." />
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      {memberResult ? (
        <Card className="mb-5 border-emerald-200 bg-emerald-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase text-emerald-700">Business member ready</p>
              <h3 className="mt-1 text-lg font-black text-slate-950">{memberResult.email}</h3>
              <p className="mt-2 text-sm text-slate-600">
                {memberResult.emailSent ? "Invite email sent." : memberResult.emailMessage ?? "Email was not sent, so share these credentials directly."}
              </p>
            </div>
            <div className="rounded-md border border-emerald-200 bg-white p-4 text-sm">
              <p className="font-black text-slate-950">Temporary password</p>
              <p className="mt-2 break-all font-mono text-slate-700">{memberResult.temporaryPassword}</p>
              <Button className="mt-3 w-full" variant="secondary" onClick={() => void navigator.clipboard.writeText(memberResult.temporaryPassword)}>
                <Copy size={16} />
                Copy Password
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
      <Card className="p-5">
        <CardHeader title="AFIO business members" subtitle="Create internal business logins and decide who can manage hospitals, modules, and other AFIO members." />
        {hasBusinessPermission("manage_members") ? (
          <>
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
              <Field label="Member email" value={memberInvite.email} placeholder="member@afio.com" onChange={(value) => setMemberInvite({ ...memberInvite, email: value })} />
              <Field label="Full name optional" value={memberInvite.fullName} placeholder="AFIO Team Member" onChange={(value) => setMemberInvite({ ...memberInvite, fullName: value })} />
              <div className="flex items-end">
                <Button className="w-full" disabled={savingMemberId === "new" || !memberInvite.email} onClick={inviteMember}>
                  <Plus size={16} />
                  {savingMemberId === "new" ? "Inviting..." : "Invite Member"}
                </Button>
              </div>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              {permissionKeys.map((key) => (
                <button
                  key={key}
                  className={`rounded-md border px-3 py-2 text-left text-sm font-bold ${memberInvite.permissions[key] ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-500"}`}
                  onClick={() => setMemberInvite({ ...memberInvite, permissions: { ...memberInvite.permissions, [key]: !memberInvite.permissions[key] } })}
                >
                  {memberInvite.permissions[key] ? "On" : "Off"} - {permissionLabels[key]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-600">Your account can view business members but cannot invite or change permissions.</p>
        )}
        <div className="mt-5 grid gap-3">
          {businessMembers.map((member) => {
            const memberIsOwner = member.email.toLowerCase() === ownerEmail;
            return (
              <div key={member.id} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-black text-slate-950">{member.fullName}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-500">{member.email}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-black uppercase text-slate-500">{memberIsOwner ? "Owner" : member.isActive ? "Member" : "Suspended"}</span>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {permissionKeys.map((key) => {
                    const enabled = memberIsOwner || member.businessPermissions?.[key] === true;
                    return (
                      <button
                        key={key}
                        className={`rounded-md border px-3 py-2 text-left text-xs font-bold ${enabled ? "border-emerald-200 bg-white text-emerald-900" : "border-slate-200 bg-white text-slate-500"}`}
                        disabled={memberIsOwner || !hasBusinessPermission("manage_members") || savingMemberId === member.id}
                        onClick={() => updateMemberPermission(member.id, { ...(member.businessPermissions ?? {}), [key]: !enabled })}
                      >
                        {enabled ? "On" : "Off"} - {permissionLabels[key]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

export function AfioBusinessAdminView() {
  const store = useDemoStore();
  const [error, setError] = useState("");
  const [savingHospitalId, setSavingHospitalId] = useState("");
  const permissionKeys: BusinessPermissionKey[] = ["manage_members", "add_hospitals", "edit_hospitals", "suspend_hospitals", "manage_modules", "delete_hospitals"];
  const permissionLabels: Record<BusinessPermissionKey, string> = {
    manage_members: "Invite/manage AFIO members",
    add_hospitals: "Add hospitals",
    edit_hospitals: "Edit hospital details",
    suspend_hospitals: "Suspend/enable hospitals",
    manage_modules: "Grant models/modules",
    delete_hospitals: "Delete hospitals"
  };
  const ownerEmail = "raahymm@gmail.com";
  const isOwner = store.currentUser.role === "afio_admin" && store.currentUser.email.toLowerCase() === ownerEmail;
  const hasBusinessPermission = (key: BusinessPermissionKey) => isOwner || store.currentUser.businessPermissions?.[key] === true;
  const [newHospital, setNewHospital] = useState({
    name: "",
    code: "",
    adminEmail: "",
    adminPassword: "",
    subscriptionStatus: "trial" as "trial" | "active" | "past_due" | "suspended",
    enabledModules: ["oct"] as ModuleId[]
  });
  const [provisionedAdmin, setProvisionedAdmin] = useState<{
    hospitalName: string;
    adminEmail: string;
    temporaryPassword: string;
    activationLink?: string;
    emailSent: boolean;
    emailMessage?: string;
  } | null>(null);
  const [memberInvite, setMemberInvite] = useState({
    email: "",
    fullName: "",
    permissions: {
      add_hospitals: true,
      edit_hospitals: true,
      suspend_hospitals: false,
      manage_modules: false,
      delete_hospitals: false,
      manage_members: false
    } as BusinessPermissions
  });
  const [memberResult, setMemberResult] = useState<{ email: string; temporaryPassword: string; emailSent: boolean; emailMessage?: string } | null>(null);
  const [savingMemberId, setSavingMemberId] = useState("");
  const [hospitalDrafts, setHospitalDrafts] = useState<Record<string, { name: string; code: string; adminEmail: string; adminPassword: string }>>({});
  const allModuleIds: ModuleId[] = ["oct", "vkg", "corneal", "retina"];
  const moduleNames: Record<ModuleId, string> = {
    oct: "OCT",
    vkg: "VKG",
    corneal: "Corneal",
    retina: "Retina"
  };

  const inviteMember = async () => {
    setError("");
    setMemberResult(null);
    setSavingMemberId("new");
    try {
      const result = await store.inviteBusinessMember(memberInvite);
      setMemberResult({
        email: result.profile.email,
        temporaryPassword: result.temporaryPassword,
        emailSent: result.emailSent,
        emailMessage: result.emailMessage
      });
      setMemberInvite({ email: "", fullName: "", permissions: memberInvite.permissions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not invite business member.");
    } finally {
      setSavingMemberId("");
    }
  };

  const updateMemberPermission = async (profileId: string, permissions: BusinessPermissions) => {
    setError("");
    setSavingMemberId(profileId);
    try {
      await store.updateBusinessMemberPermissions(profileId, permissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update business member permissions.");
    } finally {
      setSavingMemberId("");
    }
  };

  useEffect(() => {
    setHospitalDrafts((current) => {
      const next = { ...current };
      store.data.hospitals.forEach((hospital) => {
        next[hospital.id] ??= { name: hospital.name, code: hospital.code, adminEmail: hospital.adminEmail ?? "", adminPassword: "" };
      });
      return next;
    });
  }, [store.data.hospitals]);

  const updateHospital = async (hospitalId: string, input: Parameters<typeof store.updateHospitalAccess>[1]) => {
    setError("");
    setSavingHospitalId(hospitalId);
    try {
      await store.updateHospitalAccess(hospitalId, input);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update hospital.");
    } finally {
      setSavingHospitalId("");
    }
  };

  const createHospital = async () => {
    setError("");
    setProvisionedAdmin(null);
    setSavingHospitalId("new");
    try {
      const result = await store.createHospital(newHospital);
      setProvisionedAdmin({
        hospitalName: result.hospital.name,
        adminEmail: result.hospital.adminEmail ?? newHospital.adminEmail,
        temporaryPassword: result.temporaryPassword,
        activationLink: result.activationLink,
        emailSent: result.emailSent,
        emailMessage: result.emailMessage
      });
      setNewHospital({ name: "", code: "", adminEmail: "", adminPassword: "", subscriptionStatus: "trial", enabledModules: ["oct"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add hospital.");
    } finally {
      setSavingHospitalId("");
    }
  };

  const updateHospitalDetails = async (hospitalId: string) => {
    const draft = hospitalDrafts[hospitalId];
    if (!draft) return;
    setError("");
    setSavingHospitalId(hospitalId);
    try {
      const result = await store.updateHospitalDetails(hospitalId, draft);
      if (result?.temporaryPassword) {
        setProvisionedAdmin({
          hospitalName: result.hospital?.name ?? draft.name,
          adminEmail: result.hospital?.adminEmail ?? draft.adminEmail,
          temporaryPassword: result.temporaryPassword,
          emailSent: result.emailSent,
          emailMessage: result.emailMessage
        });
      }
      setHospitalDrafts((current) => ({
        ...current,
        [hospitalId]: { ...draft, adminPassword: "" }
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update hospital details.");
    } finally {
      setSavingHospitalId("");
    }
  };

  const deleteHospital = async (hospitalId: string, hospitalName: string) => {
    if (!window.confirm(`Remove ${hospitalName}? This removes the hospital access record and its module grants.`)) return;
    setError("");
    setSavingHospitalId(hospitalId);
    try {
      await store.deleteHospital(hospitalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove hospital.");
    } finally {
      setSavingHospitalId("");
    }
  };

  if (store.currentUser.role !== "afio_admin") {
    return <EmptyState title="Business Admin only" body="This page controls business access, subscriptions, and module availability." />;
  }
  const businessMembers = store.data.profiles.filter((profile) => profile.role === "afio_admin");

  return (
    <>
      <PageTitle
        title="AFIO Business Admin"
        subtitle="Provision hospitals, activate purchased modules, and hand ownership to the hospital administrator."
      />
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      {provisionedAdmin ? (
        <Card className="mb-5 border-emerald-200 bg-emerald-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase text-emerald-700">Hospital admin ready</p>
              <h3 className="mt-1 text-lg font-black text-slate-950">{provisionedAdmin.hospitalName}</h3>
              <p className="mt-2 text-sm font-semibold text-slate-700">
                {provisionedAdmin.adminEmail} can sign in as Hospital Admin and manage that hospital's own staff.
              </p>
              <p className="mt-2 text-sm text-slate-600">
                {provisionedAdmin.emailSent ? "Welcome email sent." : provisionedAdmin.emailMessage ?? "Email was not sent, so share these credentials directly."}
              </p>
              {provisionedAdmin.activationLink ? (
                <p className="mt-2 break-all text-xs font-semibold text-emerald-800">{provisionedAdmin.activationLink}</p>
              ) : null}
            </div>
            <div className="rounded-md border border-emerald-200 bg-white p-4 text-sm">
              <p className="font-black text-slate-950">Temporary password</p>
              <p className="mt-2 break-all font-mono text-slate-700">{provisionedAdmin.temporaryPassword || "Password set manually"}</p>
              <Button
                className="mt-3 w-full"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(provisionedAdmin.temporaryPassword)}
                disabled={!provisionedAdmin.temporaryPassword}
              >
                <Copy size={16} />
                Copy Password
              </Button>
              {provisionedAdmin.activationLink ? (
                <Button
                  className="mt-2 w-full"
                  variant="secondary"
                  onClick={() => void navigator.clipboard.writeText(provisionedAdmin.activationLink ?? "")}
                >
                  <Copy size={16} />
                  Copy Link
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
      <Card className="mb-5 p-5">
        <CardHeader title="Add hospital" subtitle="Creates the hospital workspace, purchased service access, first hospital admin login, and isolated patient/report ownership." />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Hospital name" value={newHospital.name} onChange={(value) => setNewHospital({ ...newHospital, name: value })} />
          <Field label="Code" value={newHospital.code} placeholder="SHIFA" onChange={(value) => setNewHospital({ ...newHospital, code: value })} />
          <Field label="Hospital admin email" value={newHospital.adminEmail} onChange={(value) => setNewHospital({ ...newHospital, adminEmail: value })} />
          <Field
            label="Temporary password optional"
            value={newHospital.adminPassword}
            placeholder="Auto-generate if blank"
            onChange={(value) => setNewHospital({ ...newHospital, adminPassword: value })}
          />
          <SelectField
            label="Subscription"
            value={newHospital.subscriptionStatus}
            options={["trial", "active", "past_due", "suspended"]}
            optionLabels={{ trial: "Trial", active: "Active", past_due: "Past due", suspended: "Suspended" }}
            onChange={(value) => setNewHospital({ ...newHospital, subscriptionStatus: value as typeof newHospital.subscriptionStatus })}
          />
          <div className="flex items-end">
            <Button className="w-full" disabled={!hasBusinessPermission("add_hospitals") || savingHospitalId === "new" || !newHospital.name || !newHospital.code || !newHospital.adminEmail} onClick={createHospital}>
              <Plus size={16} />
              {savingHospitalId === "new" ? "Provisioning..." : "Provision Hospital"}
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {allModuleIds.map((moduleId) => {
            const enabled = newHospital.enabledModules.includes(moduleId);
            return (
              <button
                key={moduleId}
                className={`rounded-md border px-3 py-2 text-sm font-bold ${enabled ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-500"}`}
                onClick={() => setNewHospital({
                  ...newHospital,
                  enabledModules: enabled ? newHospital.enabledModules.filter((id) => id !== moduleId) : [...newHospital.enabledModules, moduleId]
                })}
              >
                {enabled ? "On" : "Off"} - {moduleNames[moduleId]}
              </button>
            );
          })}
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Hospitals</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.hospitals.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.hospitals.filter((hospital) => hospital.isActive).length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Suspended</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.hospitals.filter((hospital) => hospital.subscriptionStatus === "suspended").length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Module grants</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{store.data.hospitals.reduce((total, hospital) => total + hospital.enabledModules.length, 0)}</p>
        </Card>
      </div>
      <div className="mt-5 grid gap-5">
        {store.data.hospitals.map((hospital) => (
          <Card key={hospital.id} className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-black text-slate-950">{hospital.name}</h3>
                  <StatusBadge status={hospital.isActive ? "active" : "pending"} />
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black uppercase text-slate-500">{hospital.subscriptionStatus}</span>
                </div>
                <p className="mt-2 text-sm text-slate-500">Code: {hospital.code} · Admin: {hospital.adminEmail ?? "Not assigned"}</p>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <Field
                    label="Hospital name"
                    value={hospitalDrafts[hospital.id]?.name ?? hospital.name}
                    onChange={(value) => setHospitalDrafts((current) => ({ ...current, [hospital.id]: { ...(current[hospital.id] ?? { code: hospital.code, adminEmail: hospital.adminEmail ?? "", adminPassword: "" }), name: value } }))}
                  />
                  <Field
                    label="Code"
                    value={hospitalDrafts[hospital.id]?.code ?? hospital.code}
                    onChange={(value) => setHospitalDrafts((current) => ({ ...current, [hospital.id]: { ...(current[hospital.id] ?? { name: hospital.name, adminEmail: hospital.adminEmail ?? "", adminPassword: "" }), code: value } }))}
                  />
                  <Field
                    label="Admin email"
                    value={hospitalDrafts[hospital.id]?.adminEmail ?? hospital.adminEmail ?? ""}
                    onChange={(value) => setHospitalDrafts((current) => ({ ...current, [hospital.id]: { ...(current[hospital.id] ?? { name: hospital.name, code: hospital.code, adminPassword: "" }), adminEmail: value } }))}
                  />
                  <Field
                    label="New temp password optional"
                    value={hospitalDrafts[hospital.id]?.adminPassword ?? ""}
                    placeholder="Auto if email changed"
                    onChange={(value) => setHospitalDrafts((current) => ({ ...current, [hospital.id]: { ...(current[hospital.id] ?? { name: hospital.name, code: hospital.code, adminEmail: hospital.adminEmail ?? "" }), adminPassword: value } }))}
                  />
                </div>
              </div>
              <div className="grid gap-2 sm:flex">
                <select
                  className="field min-h-10 py-2 text-sm font-semibold"
                  value={hospital.subscriptionStatus}
                  disabled={savingHospitalId === hospital.id || !hasBusinessPermission("edit_hospitals")}
                  onChange={(event) => void updateHospital(hospital.id, { subscriptionStatus: event.target.value as typeof hospital.subscriptionStatus })}
                >
                  <option value="trial">Trial</option>
                  <option value="active">Active</option>
                  <option value="past_due">Past due</option>
                  <option value="suspended">Suspended</option>
                </select>
                <Button
                  variant={hospital.isActive ? "secondary" : "primary"}
                  disabled={savingHospitalId === hospital.id || !hasBusinessPermission("suspend_hospitals")}
                  onClick={() => void updateHospital(hospital.id, { isActive: !hospital.isActive })}
                >
                  {savingHospitalId === hospital.id ? "Saving..." : hospital.isActive ? "Disable" : "Enable"}
                </Button>
                <Button variant="secondary" disabled={savingHospitalId === hospital.id || !hasBusinessPermission("edit_hospitals")} onClick={() => void updateHospitalDetails(hospital.id)}>
                  <Save size={16} />
                  Save Details
                </Button>
                <Button variant="danger" disabled={savingHospitalId === hospital.id || !hasBusinessPermission("delete_hospitals")} onClick={() => void deleteHospital(hospital.id, hospital.name)}>
                  <Trash2 size={16} />
                  Remove
                </Button>
              </div>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              {allModuleIds.map((moduleId) => {
                const enabled = hospital.enabledModules.includes(moduleId);
                return (
                  <button
                    key={moduleId}
                    className={`rounded-md border p-4 text-left transition ${enabled ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-500"}`}
                    disabled={savingHospitalId === hospital.id || !hasBusinessPermission("manage_modules")}
                    onClick={() =>
                      updateHospital(hospital.id, {
                        enabledModules: enabled
                          ? hospital.enabledModules.filter((id) => id !== moduleId)
                          : [...hospital.enabledModules, moduleId]
                      })
                    }
                  >
                    <p className="text-sm font-black">{moduleNames[moduleId]}</p>
                    <p className="mt-1 text-xs font-semibold">{enabled ? "Enabled for hospital" : "Hidden from hospital"}</p>
                  </button>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

export function NewPatientView() {
  const store = useDemoStore();
  const searchParams = useSearchParams();
  const moduleId = moduleFromSearchParams(searchParams);
  const activeModuleLabel = getModuleLabel(moduleId);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [createdPatient, setCreatedPatient] = useState<Patient | null>(null);
  const [form, setForm] = useState({
    patientCode: `MCS-${moduleId.toUpperCase()}-${String(store.data.patients.length + 1).padStart(4, "0")}`,
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
      const patient = await store.createPatient({ ...form, cnic: formatCnic(form.cnic), age: Number(form.age), moduleId });
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
      <PageTitle title={`New ${activeModuleLabel} Patient`} subtitle={`Create a patient record inside the ${activeModuleLabel} workflow before uploading an image.`} />
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
  const searchParams = useSearchParams();
  const moduleId = moduleFromSearchParams(searchParams);
  const activeModuleLabel = getModuleLabel(moduleId);
  const [query, setQuery] = useState("");
  const modulePatients = filterPatientsForModule(store.data.patients, store.data.scans, moduleId);
  const results = modulePatients.filter((patient) => {
    const value = `${patient.patientCode} ${patient.cnic ?? ""} ${patient.fullName} ${patient.phone}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });
  return (
    <>
      <PageTitle title={`${activeModuleLabel} Patients`} subtitle={`Find ${activeModuleLabel} records by patient ID, CNIC, name, or phone number. Hospital-wide totals stay on the dashboard.`} />
      <Card className="p-5">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
          <input className="field pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search MCS-${moduleId.toUpperCase()}-0001, CNIC, patient name, phone...`} />
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
          <CardHeader title="Uploaded Scans" subtitle="Each scan links to the screening result page." />
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
                        Result: {ai ? `${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)` : "Not analyzed"}
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
  const searchParams = useSearchParams();
  const store = useDemoStore();
  const moduleId = moduleFromSearchParams(searchParams);
  const moduleLabel = getModuleLabel(moduleId);
  const modulePatients = filterPatientsForModule(store.data.patients, store.data.scans, moduleId);
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
  const [retinaServices, setRetinaServices] = useState<RetinaServiceSelection>({ dr: true, glaucoma: true, hr: true });

  const onFile = async (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setError(`Only JPG, JPEG, and PNG ${moduleLabel} images are supported.`);
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
      setError(`Please select a patient and upload a ${moduleLabel} image.`);
      return;
    }
    setLoading(true);
    try {
      if (moduleId === "corneal") {
        throw new Error(`${moduleLabel} screening backend is not connected yet. Use this module workspace for patient setup until the service is live.`);
      }
      const preparedAgain = await prepareScanImages(predictionFile);
      const prediction = moduleId === "retina"
        ? await predictRetina(preparedAgain.predictionFile, { services: retinaServices, imageQualityWarnings: preparedAgain.quality.warnings })
        : moduleId === "vkg"
          ? await predictVKG(predictionFile)
          : await predictOCTWithGradcam(predictionFile);
      if (!prediction.is_valid_oct) {
        const message =
          prediction.prediction === "INVALID_IMAGE"
            ? `Invalid image uploaded. Please upload a valid ${moduleLabel} scan.`
            : "Low-confidence result. The scan could not be classified confidently and requires doctor review.";
        setAnalysisWarning(`${message} ${prediction.disclaimer}`);
        return;
      }

      const scan = await store.addScan({ patientId, imageUrl, eyeSide, scanNotes, file: selectedFile, moduleId });
      const aiResult = await store.saveBackendAnalysis(scan, prediction);
      await store.createReport(scan, aiResult);
      router.push(`/scans/${scan.id}/analysis`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screening failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageTitle title={`Upload ${moduleLabel} Scan`} subtitle={`Upload a patient ${moduleLabel} image for screening and draft report preparation.`} />
      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
        <Card className="p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              label="Patient"
              value={patientId}
              options={["", ...modulePatients.map((patient) => patient.id)]}
              optionLabels={{ "": `Select ${moduleLabel} patient`, ...Object.fromEntries(modulePatients.map((patient) => [patient.id, `${patient.patientCode} - ${patient.fullName}`])) }}
              onChange={setPatientId}
            />
            <SelectField label="Eye side" value={eyeSide} options={["Left", "Right", "Both", "Unknown"]} onChange={(value) => setEyeSide(value as EyeSide)} />
          </div>
          <Textarea label="Scan notes" value={scanNotes} onChange={setScanNotes} />
          {moduleId === "retina" ? <div className="mt-4"><RetinaServiceSelector value={retinaServices} onChange={setRetinaServices} disabled={loading} /></div> : null}
          <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 px-5 py-12 text-center hover:border-clinic-300">
            <Upload className="text-clinic-600" size={28} />
            <span className="mt-3 font-bold text-slate-900">Upload {moduleLabel} image</span>
            <span className="text-sm text-slate-500">JPG, JPEG, or PNG</span>
            <input className="hidden" type="file" accept=".jpg,.jpeg,.png" onChange={(event) => onFile(event.target.files?.[0])} />
          </label>
          {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
          {fileNote ? <p className="mt-4 rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800">{fileNote}</p> : null}
          {analysisWarning ? <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">{analysisWarning}</p> : null}
          <div className="mt-5 flex justify-end">
            <Button className="w-full sm:w-auto" onClick={submit} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
              {loading ? `Analyzing ${moduleLabel} image...` : "Save and Analyze"}
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
  const [retinaServices, setRetinaServices] = useState<RetinaServiceSelection>({ dr: true, glaucoma: true, hr: true });
  const [retinaTab, setRetinaTab] = useState<"summary" | "dr" | "glaucoma" | "hr">("summary");
  const scan = store.data.scans.find((item) => item.id === id);
  if (!scan) return <Missing title="Scan not found" href="/dashboard" label="Back to dashboard" />;
  const patient = store.data.patients.find((item) => item.id === scan.patientId);
  const aiResult = store.data.aiResults.find((item) => item.scanId === scan.id);
  const linkedReport = aiResult ? store.data.reports.find((report) => report.aiResultId === aiResult.id) : undefined;
  const canManageAnalysis = store.currentUser.role === "doctor" || store.currentUser.role === "hospital_admin" || store.currentUser.role === "admin";
  const canManageScan = canManageAnalysis;
  const analysisClasses = scan.moduleId === "retina" ? retinaClasses : scan.moduleId === "vkg" ? vkgClasses : diseaseClasses;

  const analyzeScan = async () => {
    setAnalysisError("");
    setAnalysisLoading(true);
    try {
      const response = await fetch(scan.imageUrl);
      if (!response.ok) throw new Error("Could not reload the scan image for analysis.");
      const blob = await response.blob();
      const file = new File([blob], `${scan.id}.jpg`, { type: blob.type || "image/jpeg" });
      const prepared = await prepareScanImages(file);
      const prediction = scan.moduleId === "retina"
        ? await predictRetina(prepared.predictionFile, { services: retinaServices, imageQualityWarnings: prepared.quality.warnings })
        : scan.moduleId === "vkg"
          ? await predictVKG(prepared.predictionFile)
          : await predictOCTWithGradcam(prepared.predictionFile);
      const result = await store.saveBackendAnalysis(scan, prediction);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed.";
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
        title="Screening Result"
        subtitle={patient ? `${patient.patientCode} - ${patient.fullName}` : "OCT scan analysis"}
        action={
          <Button className="w-full" onClick={generate}>
            <FileText size={16} />
            Generate Report
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(360px,.95fr)_minmax(560px,1.05fr)]">
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
            <h3 className="font-black text-slate-950">Screening Output</h3>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">{aiResult?.modelName ?? "Not analyzed"}</span>
          </div>
          <SafetyNotice />
          {analysisError ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{analysisError}</p> : null}
          {aiResult ? (
            <div className="mt-5 space-y-5">
              {scan.moduleId === "retina" ? (
                <RetinaResultDetails aiResult={aiResult} activeTab={retinaTab} onTabChange={setRetinaTab} />
              ) : (
                <>
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-sm font-semibold text-slate-500">Predicted finding</p>
                    <p className="mt-1 text-4xl font-black text-clinic-700">{aiResult.predictedClass}</p>
                    <p className="mt-1 text-sm text-slate-500">Confidence {Math.round(aiResult.confidence * 100)}%</p>
                  </div>
                  <div className="space-y-3">
                    {analysisClasses.map((item) => (
                      <Probability key={item} label={item} value={aiResult.probabilities[item] ?? 0} active={item === aiResult.predictedClass} />
                    ))}
                  </div>
                </>
              )}
              {aiResult.heatmapUrl ? (
                <div className="rounded-md border border-slate-200 bg-white p-3">
                  <p className="text-sm font-black text-slate-950">Grad-CAM attention heatmap</p>
                  <img src={imageDisplaySource(aiResult.heatmapUrl)} alt="Grad-CAM heatmap overlay" className="mt-3 aspect-[4/3] w-full rounded-md bg-slate-900 object-cover" />
                  <p className="mt-2 text-xs font-medium leading-relaxed text-slate-500">
                    Highlighted regions influenced the screening result. This is not a segmentation map or measurement.
                  </p>
                </div>
              ) : null}
              <CleanModelVersion aiResult={aiResult} />
              <Info label="Timestamp" value={new Date(aiResult.createdAt).toLocaleString()} />
              {scan.moduleId === "retina" ? <RetinaServiceSelector value={retinaServices} onChange={setRetinaServices} disabled={analysisLoading} /> : null}
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
              <EmptyState title="No result yet" body="Run analysis to create a preliminary screening result for this scan." />
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
  const reportModuleId = draft.moduleId ?? scan?.moduleId ?? ai?.moduleId ?? "oct";
  const reportModuleClasses = reportClassesForModule(reportModuleId);
  const canApprove = store.currentUser.role === "doctor";
  const canManageScan = store.currentUser.role === "doctor" || store.currentUser.role === "hospital_admin" || store.currentUser.role === "admin";
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
      router.push(reportHistoryHref(reportModuleId));
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
              <Info label="Screening result" value={`${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)`} />
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
              options={["Needs clinical correlation", ...reportModuleClasses]}
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
  const reportModuleId = report.moduleId ?? scan?.moduleId ?? ai?.moduleId ?? "oct";
  const reportModuleLabel = getModuleLabel(reportModuleId);
  const isApprovedReport = report.status === "approved";
  const approver = store.data.profiles.find((item) => item.id === report.approvedBy);
  const canDoctorEdit = store.currentUser.role === "doctor";
  const canManageScan = store.currentUser.role === "doctor" || store.currentUser.role === "hospital_admin" || store.currentUser.role === "admin";

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
      router.push(reportHistoryHref(reportModuleId));
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
              {report.status === "approved"
                ? `Doctor-Approved ${reportModuleLabel} Report`
                : report.status === "rejected"
                  ? `Rejected ${reportModuleLabel} Report`
                  : report.status === "superseded"
                    ? `Superseded ${reportModuleLabel} Report`
                    : `${reportModuleLabel} Report`}
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
              {isApprovedReport ? (
                <Info label="Clinical result" value={report.finalDiagnosis} />
              ) : ai ? (
                <Info label="Screening result" value={`${ai.predictedClass} (${Math.round(ai.confidence * 100)}%)`} />
              ) : null}
              <Info label="Approved by" value={approver?.fullName ?? "Not approved"} />
              <Info label="Approved at" value={report.approvedAt ? new Date(report.approvedAt).toLocaleString() : "Not approved"} />
            </div>
          </div>
          <div className="space-y-5">
            {isApprovedReport ? null : <SafetyNotice />}
            <ReportSection title="Findings" body={isApprovedReport ? patientSafeReportText(report.findings) : report.findings} />
            <ReportSection title="Impression" body={isApprovedReport ? patientSafeReportText(report.impression) : report.impression} />
            <ReportSection title="Recommendation" body={isApprovedReport ? patientSafeReportText(report.recommendation) : report.recommendation} />
            <ReportSection title="Doctor Notes" body={isApprovedReport ? patientSafeReportText(report.doctorNotes || "No additional notes.") : report.doctorNotes || "No additional notes."} />
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
  const searchParams = useSearchParams();
  const moduleId = moduleFromSearchParams(searchParams);
  const moduleLabel = getModuleLabel(moduleId);
  const [query, setQuery] = useState("");
  const reports = store.data.reports.filter((report) => (report.moduleId ?? "oct") === moduleId).filter((report) => {
    const patient = store.data.patients.find((item) => item.id === report.patientId);
    const ai = store.data.aiResults.find((item) => item.id === report.aiResultId);
    return `${patient?.patientCode} ${patient?.cnic ?? ""} ${patient?.fullName} ${report.status} ${ai?.predictedClass} ${report.finalDiagnosis}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });
  return (
    <>
      <PageTitle title={`${moduleLabel} Report History`} subtitle={`Search ${moduleLabel} reports by patient ID, CNIC, name, status, screening result, or final diagnosis.`} />
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
  const publicReport = publicResult?.report;
  const publicReportHistory = publicResult?.reports ?? [];

  const checkReport = async () => {
    setCheckError("");
    setPublicResult(null);
    if (!accessId.trim() || !password.trim()) return;

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
    if (passwordForm.newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
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
            <Field label="Access password" type="password" value={password} onChange={setPassword} />
            <Button onClick={checkReport} disabled={checking || !accessId.trim() || !password.trim()}>
              {checking ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
              Check Report
            </Button>
          </div>
          <div className="mt-5 rounded-md border border-slate-200 bg-slate-50 p-4">
            <p className="font-bold text-slate-950">Access flow</p>
            <div className="mt-3 space-y-3 text-sm font-semibold text-slate-600">
              <p>1. Clinic creates and reviews the report.</p>
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
                <p className="mt-1 text-sm font-semibold text-slate-500">View previous approved reports.</p>
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
          ) : !publicResult ? (
            <EmptyState title="Ready to check" body="Press Check Report to verify the access ID and password." />
          ) : publicResult && !publicResult.found ? (
            <EmptyState title="No matching report" body={publicResult.message ?? "Check the report access ID and password, or contact the clinic."} />
          ) : publicResult && !publicResult.approved ? (
            <div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
                <h3 className="text-xl font-black text-amber-950">Report not made available yet</h3>
                <p className="mt-2 text-sm font-semibold leading-6 text-amber-800">
                  This report is registered, but it cannot be viewed before doctor approval. Please check again after review is complete.
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
        {!reports.length ? <EmptyState title="No past reports" body="Approved reports will appear here after the clinic reviews them." /> : null}
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
  const canReview = store.currentUser.role === "hospital_admin" || store.currentUser.role === "admin" || store.currentUser.role === "afio_admin";
  const visibleModuleIds = new Set(store.visibleModuleIds);
  const scopedEntries = entries.filter((entry) => {
    if (store.currentUser.role === "afio_admin") return true;
    if (entry.clinicId !== store.currentUser.clinicId) return false;
    return !entry.moduleId || visibleModuleIds.has(entry.moduleId);
  });
  const visible = scopedEntries.filter((entry) => {
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
          <p className="mt-2 text-3xl font-black text-slate-950">{scopedEntries.filter((entry) => entry.status === "new").length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Messages sent</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{scopedEntries.reduce((total, entry) => total + (entry.responses?.length ?? 0), 0)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-slate-500">Resolved</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{scopedEntries.filter((entry) => entry.status === "resolved").length}</p>
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
            <div className="mt-4 grid gap-3 md:grid-cols-5">
              <Info label="Service" value={entry.moduleId ? getModuleLabel(entry.moduleId) : "General"} />
              <Info label="Hospital" value={entry.hospitalName || store.data.hospitals.find((hospital) => hospital.id === entry.clinicId)?.name || "-"} />
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
  const visibleProfiles =
    store.currentUser.role === "afio_admin"
      ? store.data.profiles
      : store.data.profiles.filter((profile) => profile.clinicId === store.currentUser.clinicId);

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

  const removeAccess = async (profileId: string, profileName: string, mode: "reject" | "delete") => {
    const action = mode === "reject" ? "Reject" : "Delete";
    if (!window.confirm(`${action} ${profileName}? This removes their login and access record.`)) return;
    setError("");
    setSavingId(profileId);
    try {
      await store.deleteProfileAccess(profileId);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${mode} user.`);
    } finally {
      setSavingId("");
    }
  };

  return (
    <>
      <PageTitle title="User Access" subtitle="Approve hospital staff and assign clinical roles. Business Admin sees all hospitals; hospital admins see only their own staff." />
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      <div className="space-y-3 md:hidden">
        {visibleProfiles.map((profile) => {
          const hospital = store.data.hospitals.find((item) => item.id === profile.clinicId);
          return (
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
                  disabled={savingId === profile.id || profile.role === "afio_admin"}
                  onChange={(event) => updateAccess(profile.id, { role: event.target.value as Role })}
                >
                  <option value="doctor">Doctor</option>
                  <option value="assistant">Assistant</option>
                  <option value="hospital_admin">Hospital Admin</option>
                </select>
              </label>
              <Info label="Hospital" value={hospital?.name ?? "AFIO Platform"} />
              <Info label="Doctor ID" value={profile.doctorId ?? "-"} />
              {profile.role === "afio_admin" ? (
                <span className="rounded-md bg-slate-100 px-3 py-2 text-center text-xs font-bold uppercase text-slate-500">Owner</span>
              ) : profile.isActive ? (
                <div className="grid gap-2">
                  <Button
                    className="w-full"
                    variant="secondary"
                    disabled={savingId === profile.id}
                    onClick={() => updateAccess(profile.id, { isActive: false })}
                  >
                    Suspend Access
                  </Button>
                  <Button className="w-full" variant="danger" disabled={savingId === profile.id} onClick={() => removeAccess(profile.id, profile.fullName, "delete")}>
                    Delete User
                  </Button>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Button className="w-full" disabled={savingId === profile.id} onClick={() => updateAccess(profile.id, { isActive: true })}>
                    Approve Access
                  </Button>
                  <Button className="w-full" variant="danger" disabled={savingId === profile.id} onClick={() => removeAccess(profile.id, profile.fullName, "reject")}>
                    Reject Request
                  </Button>
                </div>
              )}
            </div>
          </Card>
        );
        })}
        {visibleProfiles.length === 0 ? <EmptyState title="No account requests yet" body="New signup requests will appear here." /> : null}
      </div>
      <Card className="hidden overflow-hidden md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Hospital</th>
              <th className="px-5 py-3">Doctor ID</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleProfiles.map((profile) => {
              const hospital = store.data.hospitals.find((item) => item.id === profile.clinicId);
              return (
              <tr key={profile.id}>
                <td className="px-5 py-4 font-bold">{profile.fullName}</td>
                <td className="px-5 py-4">{profile.email}</td>
                <td className="px-5 py-4">
                  <select
                    className="field min-w-32 py-2 capitalize"
                    value={profile.role}
                    disabled={savingId === profile.id || profile.role === "afio_admin"}
                    onChange={(event) => updateAccess(profile.id, { role: event.target.value as Role })}
                  >
                    <option value="afio_admin">Business Admin</option>
                    <option value="doctor">Doctor</option>
                    <option value="assistant">Assistant</option>
                    <option value="hospital_admin">Hospital Admin</option>
                  </select>
                </td>
                <td className="px-5 py-4">{hospital?.name ?? "AFIO Platform"}</td>
                <td className="px-5 py-4">{profile.doctorId ?? "-"}</td>
                <td className="px-5 py-4"><StatusBadge status={profile.isActive ? "active" : "pending"} /></td>
                <td className="px-5 py-4">
                  {profile.role === "afio_admin" ? (
                    <span className="text-xs font-bold uppercase text-slate-400">Owner</span>
                  ) : profile.isActive ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        disabled={savingId === profile.id}
                        onClick={() => updateAccess(profile.id, { isActive: false })}
                      >
                        Suspend
                      </Button>
                      <Button variant="danger" disabled={savingId === profile.id} onClick={() => removeAccess(profile.id, profile.fullName, "delete")}>
                        Delete
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={savingId === profile.id} onClick={() => updateAccess(profile.id, { isActive: true })}>
                        Approve
                      </Button>
                      <Button variant="danger" disabled={savingId === profile.id} onClick={() => removeAccess(profile.id, profile.fullName, "reject")}>
                        Reject
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
            })}
            {visibleProfiles.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-center text-sm font-semibold text-slate-500" colSpan={7}>
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
  const searchParams = useSearchParams();
  const moduleId = moduleFromSearchParams(searchParams);
  const moduleLabel = getModuleLabel(moduleId);
  const moduleClasses = reportClassesForModule(moduleId);
  const canEditTemplates = store.currentUser.role === "hospital_admin" || store.currentUser.role === "admin" || store.currentUser.role === "doctor";
  const [templates, setTemplates] = useState(reportTemplates);
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [medicine, setMedicine] = useState({
    template: (moduleId === "retina" ? "NO_DR" : moduleId === "vkg" ? "KCN" : "DME") as ClinicalClass,
    name: "",
    dose: "",
    route: "Oral",
    frequency: "Once daily",
    duration: "",
    instructions: ""
  });

  const updateTemplate = (disease: ClinicalClass, field: "findings" | "impression" | "recommendation", value: string) => {
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
    getReportTemplates(moduleId)
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
  }, [moduleId]);

  useEffect(() => {
    setMedicine((current) => ({
      ...current,
      template: (moduleId === "retina" ? "NO_DR" : moduleId === "vkg" ? "KCN" : "DME") as ClinicalClass
    }));
  }, [moduleId]);

  const saveTemplates = async () => {
    setSaving(true);
    try {
      await saveReportTemplates(templates, moduleId);
      setSaved(`${moduleLabel} report templates saved to Supabase.`);
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
      await saveReportTemplates(reportTemplates, moduleId);
      setSaved(`${moduleLabel} templates reset to defaults in Supabase.`);
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
        title={`${moduleLabel} Report Templates`}
        subtitle={`Edit the default ${moduleLabel} draft text doctors receive when reports are created.`}
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
            options={moduleClasses}
            onChange={(value) => setMedicine({ ...medicine, template: value as ClinicalClass })}
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
        {moduleClasses.map((item) => (
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
              <p className="text-sm text-slate-500">{patient?.patientCode ?? "-"} | Result: {ai?.predictedClass ?? "-"}</p>
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
  const store = useDemoStore();
  const [form, setForm] = useState({
    type: "feedback" as FeedbackEntry["type"],
    clinicId: store.currentHospital?.id ?? "",
    moduleId: "oct" as ModuleId,
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
        clinicId: form.clinicId || undefined,
        hospitalName: store.data.hospitals.find((hospital) => hospital.id === form.clinicId)?.name,
        moduleId: form.moduleId,
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
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  label="Hospital"
                  value={form.clinicId}
                  options={["", ...store.data.hospitals.map((hospital) => hospital.id)]}
                  optionLabels={{ "": "Select hospital", ...Object.fromEntries(store.data.hospitals.map((hospital) => [hospital.id, hospital.name])) }}
                  onChange={(value) => setForm({ ...form, clinicId: value })}
                />
                <SelectField
                  label="Service"
                  value={form.moduleId}
                  options={["oct", "vkg", "corneal", "retina"]}
                  optionLabels={{ oct: "OCT", vkg: "VKG", corneal: "Corneal", retina: "Retina" }}
                  onChange={(value) => setForm({ ...form, moduleId: value as ModuleId })}
                />
              </div>
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
