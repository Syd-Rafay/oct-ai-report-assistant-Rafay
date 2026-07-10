"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getReportTemplates, reportTemplates, safetyDisclaimer } from "./report-templates";
import { supabase } from "./supabase";
import { isDiseaseClass } from "./types";
import type {
  AiResult,
  AppData,
  AuditLog,
  BackendPrediction,
  DiseaseClass,
  EyeSide,
  Patient,
  Profile,
  Report,
  Role,
  Scan
} from "./types";

const STORAGE_KEY = "oct-ai-report-assistant-demo-v1";
const SUPER_ADMIN_EMAIL = "raahymm@gmail.com";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const demoProfiles: Profile[] = [
  {
    id: "user_admin",
    fullName: "Dr. Asad Ullah",
    email: "admin@octai.local",
    role: "admin",
    doctorId: "NUST-ADM-01",
    specialization: "Ophthalmology AI Program",
    clinicName: "Military College of Signals, NUST",
    isActive: true
  },
  {
    id: "user_doctor",
    fullName: "Dr. Nida Sohail",
    email: "doctor@octai.local",
    role: "doctor",
    doctorId: "RET-204",
    specialization: "Retina",
    clinicName: "MCS Clinical Imaging Lab",
    isActive: true
  },
  {
    id: "user_assistant",
    fullName: "Clinical Assistant",
    email: "assistant@octai.local",
    role: "assistant",
    specialization: "OCT Technician",
    clinicName: "MCS Clinical Imaging Lab",
    isActive: true
  }
];

const patientId = "patient_demo_1";
const scanId = "scan_demo_1";
const aiId = "ai_demo_1";
const reportId = "report_demo_1";

export const seedData: AppData = {
  currentUserId: "user_doctor",
  profiles: demoProfiles,
  patients: [
    {
      id: patientId,
      patientCode: "MCS-OCT-0001",
      cnic: "61101-2910291-3",
      fullName: "Ayesha Khan",
      age: 56,
      gender: "Female",
      phone: "0300-0000000",
      email: "ayesha@example.com",
      address: "Islamabad",
      diabetesHistory: "Yes",
      previousEyeDisease: "Mild diabetic retinopathy history",
      clinicalNotes: "Reduced central vision in right eye for two weeks.",
      createdBy: "user_doctor",
      createdAt: "2026-06-30T14:15:00.000Z",
      updatedAt: "2026-06-30T14:15:00.000Z"
    }
  ],
  scans: [
    {
      id: scanId,
      patientId,
      imageUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='620' viewBox='0 0 900 620'%3E%3Crect width='900' height='620' fill='%230b1320'/%3E%3Cpath d='M60 315 C170 230 260 285 365 308 C470 335 545 340 650 294 C740 254 812 270 860 312' fill='none' stroke='%23a7f3d0' stroke-width='22' opacity='.95'/%3E%3Cpath d='M60 354 C190 330 290 371 420 386 C560 402 680 365 860 344' fill='none' stroke='%2338bdf8' stroke-width='18' opacity='.78'/%3E%3Cellipse cx='470' cy='318' rx='92' ry='42' fill='%23f59e0b' opacity='.28'/%3E%3Ccircle cx='500' cy='310' r='18' fill='%23fde68a' opacity='.8'/%3E%3Ctext x='42' y='70' fill='%23cbd5e1' font-family='Arial' font-size='28'%3EDemo OCT B-scan%3C/text%3E%3C/svg%3E",
      storagePath: "oct-scans/patient_demo_1/scan_demo_1.jpg",
      scanType: "OCT",
      eyeSide: "Right",
      scanNotes: "Macular cube OCT uploaded for demo analysis.",
      uploadedBy: "user_assistant",
      createdAt: "2026-06-30T14:20:00.000Z"
    }
  ],
  aiResults: [
    {
      id: aiId,
      scanId,
      predictedClass: "DME",
      confidence: 0.87,
      probabilities: { CNV: 0.04, DME: 0.87, DRUSEN: 0.06, NORMAL: 0.03 },
      modelName: "EfficientNet-B0",
      modelVersion: "demo-v1.0",
      isDummyResult: true,
      createdAt: "2026-06-30T14:21:00.000Z"
    }
  ],
  reports: [
    {
      id: reportId,
      patientId,
      scanId,
      aiResultId: aiId,
      ...reportTemplates.DME,
      doctorNotes: "Review OCT with visual acuity and diabetic history before treatment planning.",
      finalDiagnosis: "Needs clinical correlation",
      status: "pending_review",
      createdBy: "user_doctor",
      createdAt: "2026-06-30T14:23:00.000Z",
      updatedAt: "2026-06-30T14:23:00.000Z"
    }
  ],
  auditLogs: [
    {
      id: "audit_demo_1",
      userId: "user_doctor",
      action: "AI analysis generated",
      recordType: "scan",
      recordId: scanId,
      details: safetyDisclaimer,
      createdAt: "2026-06-30T14:21:00.000Z"
    }
  ]
};

const emptyData: AppData = {
  currentUserId: "",
  profiles: [],
  patients: [],
  scans: [],
  aiResults: [],
  reports: [],
  auditLogs: []
};

type DbProfile = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  doctor_id: string | null;
  specialization: string | null;
  clinic_name: string | null;
  clinic_id: string | null;
  default_department_id: string | null;
  is_active: boolean | null;
};

type DbPatient = {
  id: string;
  patient_code: string;
  cnic: string | null;
  access_password: string | null;
  full_name: string;
  age: number;
  gender: Patient["gender"];
  phone: string | null;
  email: string | null;
  address: string | null;
  diabetes_history: Patient["diabetesHistory"] | null;
  previous_eye_disease: string | null;
  clinical_notes: string | null;
  clinic_id: string | null;
  department_id: string | null;
  global_patient_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type DbScan = {
  id: string;
  patient_id: string;
  image_url: string;
  storage_path: string;
  scan_type: Scan["scanType"] | null;
  clinic_id: string | null;
  department_id: string | null;
  module_id: Scan["moduleId"] | null;
  eye_side: EyeSide;
  scan_notes: string | null;
  uploaded_by: string | null;
  created_at: string;
};

type DbAiResult = {
  id: string;
  scan_id: string;
  predicted_class: DiseaseClass;
  confidence: number;
  probabilities: Record<DiseaseClass, number>;
  model_name: string | null;
  model_version: string | null;
  heatmap_url: string | null;
  module_id: AiResult["moduleId"] | null;
  is_dummy_result: boolean | null;
  created_at: string;
};

type DbReport = {
  id: string;
  patient_id: string;
  scan_id: string;
  ai_result_id: string;
  findings: string | null;
  impression: string | null;
  recommendation: string | null;
  doctor_notes: string | null;
  final_diagnosis: Report["finalDiagnosis"] | null;
  clinic_id: string | null;
  department_id: string | null;
  module_id: Report["moduleId"] | null;
  status: Report["status"];
  approved_by: string | null;
  pdf_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
};

type DbAuditLog = {
  id: string;
  user_id: string | null;
  action: string;
  record_type: string | null;
  record_id: string | null;
  details: unknown;
  created_at: string;
};

function readStore(): AppData {
  if (typeof window === "undefined") return seedData;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedData;
  try {
    return JSON.parse(raw) as AppData;
  } catch {
    return seedData;
  }
}

function writeStore(data: AppData) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function audit(data: AppData, action: string, recordType: string, recordId: string, details: string) {
  const entry: AuditLog = {
    id: id("audit"),
    userId: data.currentUserId,
    action,
    recordType,
    recordId,
    details,
    createdAt: now()
  };
  return { ...data, auditLogs: [entry, ...data.auditLogs] };
}

function normalizeProbabilities(prediction: DiseaseClass) {
  const confidence = Number((0.79 + Math.random() * 0.14).toFixed(2));
  const probabilities = {} as Record<DiseaseClass, number>;
  const others = ["CNV", "DME", "DRUSEN", "NORMAL"].filter((key) => key !== prediction) as DiseaseClass[];
  const first = Number(((1 - confidence) * 0.42).toFixed(2));
  const second = Number(((1 - confidence) * 0.35).toFixed(2));
  const third = Number((1 - confidence - first - second).toFixed(2));
  probabilities[prediction] = confidence;
  probabilities[others[0]] = first;
  probabilities[others[1]] = second;
  probabilities[others[2]] = third;
  return probabilities;
}

function dataUrlToBlob(dataUrl: string) {
  const [metadata, base64Data] = dataUrl.split(",");
  const mime = metadata.match(/^data:(.*?);base64$/)?.[1] ?? "image/png";
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function octScansPublicPath(url?: string) {
  if (!url) return undefined;
  const marker = "/storage/v1/object/public/oct-scans/";
  const index = url.indexOf(marker);
  if (index === -1) return undefined;
  return decodeURIComponent(url.slice(index + marker.length));
}

function userProfile(user: User): Profile {
  const email = user.email ?? "";
  const isSuperAdmin = email.toLowerCase() === SUPER_ADMIN_EMAIL;
  return {
    id: user.id,
    fullName: user.user_metadata?.full_name ?? email.split("@")[0] ?? "Clinical user",
    email,
    role: isSuperAdmin ? "admin" : (user.user_metadata?.role as Role | undefined) ?? "doctor",
    doctorId: user.user_metadata?.doctor_id,
    specialization: user.user_metadata?.department,
    clinicName: user.user_metadata?.clinic_name ?? user.user_metadata?.department ?? "Clinical OCT Service",
    isActive: isSuperAdmin
  };
}

function mapProfile(row: DbProfile): Profile {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    doctorId: row.doctor_id ?? undefined,
    specialization: row.specialization ?? undefined,
    clinicName: row.clinic_name ?? undefined,
    clinicId: row.clinic_id ?? undefined,
    defaultDepartmentId: row.default_department_id ?? undefined,
    isActive: row.is_active ?? true
  };
}

function mapPatient(row: DbPatient): Patient {
  return {
    id: row.id,
    patientCode: row.patient_code,
    cnic: row.cnic ?? undefined,
    accessPassword: row.access_password ?? undefined,
    fullName: row.full_name,
    age: row.age,
    gender: row.gender,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    address: row.address ?? undefined,
    diabetesHistory: row.diabetes_history ?? "Unknown",
    previousEyeDisease: row.previous_eye_disease ?? undefined,
    clinicalNotes: row.clinical_notes ?? undefined,
    clinicId: row.clinic_id ?? undefined,
    departmentId: row.department_id ?? undefined,
    globalPatientKey: row.global_patient_key ?? undefined,
    createdBy: row.created_by ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapScan(row: DbScan): Scan {
  return {
    id: row.id,
    patientId: row.patient_id,
    imageUrl: row.image_url,
    storagePath: row.storage_path,
    scanType: row.scan_type ?? "OCT",
    clinicId: row.clinic_id ?? undefined,
    departmentId: row.department_id ?? undefined,
    moduleId: row.module_id ?? "oct",
    eyeSide: row.eye_side,
    scanNotes: row.scan_notes ?? undefined,
    uploadedBy: row.uploaded_by ?? "",
    createdAt: row.created_at
  };
}

function mapAiResult(row: DbAiResult): AiResult {
  return {
    id: row.id,
    scanId: row.scan_id,
    predictedClass: row.predicted_class,
    confidence: Number(row.confidence),
    probabilities: row.probabilities,
    modelName: row.model_name ?? "EfficientNet-B3",
    modelVersion: row.model_version ?? "v1.0",
    heatmapUrl: row.heatmap_url ?? undefined,
    moduleId: row.module_id ?? "oct",
    isDummyResult: row.is_dummy_result ?? false,
    createdAt: row.created_at
  };
}

function mapReport(row: DbReport): Report {
  return {
    id: row.id,
    patientId: row.patient_id,
    scanId: row.scan_id,
    aiResultId: row.ai_result_id,
    findings: row.findings ?? "",
    impression: row.impression ?? "",
    recommendation: row.recommendation ?? "",
    doctorNotes: row.doctor_notes ?? "",
    finalDiagnosis: row.final_diagnosis ?? "Needs clinical correlation",
    clinicId: row.clinic_id ?? undefined,
    departmentId: row.department_id ?? undefined,
    moduleId: row.module_id ?? "oct",
    status: row.status,
    approvedBy: row.approved_by ?? undefined,
    pdfUrl: row.pdf_url ?? undefined,
    createdBy: row.created_by ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at ?? undefined
  };
}

function mapAuditLog(row: DbAuditLog): AuditLog {
  return {
    id: row.id,
    userId: row.user_id ?? "",
    action: row.action,
    recordType: row.record_type ?? "",
    recordId: row.record_id ?? "",
    details: typeof row.details === "string" ? row.details : JSON.stringify(row.details ?? {}),
    createdAt: row.created_at
  };
}

function mergeCurrentProfile(profiles: Profile[], user: User | null) {
  if (!user) return profiles;
  return profiles.some((profile) => profile.id === user.id) ? profiles : [userProfile(user), ...profiles];
}

async function ensureProfile(user: User) {
  if (!supabase) return;
  const fallback = userProfile(user);
  const { data: existing, error: lookupError } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Could not check profile approval: ${lookupError.message}`);
  }

  if (existing) return;

  const { error } = await supabase.from("profiles").insert({
    id: user.id,
    full_name: fallback.fullName,
    email: fallback.email,
    role: fallback.role,
    doctor_id: fallback.doctorId ?? null,
    specialization: fallback.specialization ?? null,
    clinic_name: fallback.clinicName ?? "OCT AI Clinic",
    is_active: fallback.isActive
  });

  if (error) {
    throw new Error(`Could not create profile: ${error.message}`);
  }
}

function requireApprovedProfile(profile: Profile) {
  if (profile.email.toLowerCase() === SUPER_ADMIN_EMAIL) return;
  if (!profile.isActive) {
    throw new Error("Your account is waiting for approval from raahymm@gmail.com.");
  }
}

async function insertAudit(userId: string | null, action: string, recordType: string, recordId: string, details: string) {
  if (!supabase || !userId) return;
  await supabase.from("audit_logs").insert({
    user_id: userId,
    action,
    record_type: recordType,
    record_id: recordId,
    details: { message: details }
  });
}

export function useDemoStore() {
  const [data, setData] = useState<AppData>(emptyData);
  const [ready, setReady] = useState(false);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [mode, setMode] = useState<"supabase" | "demo">("supabase");

  const currentUser = useMemo(
    () =>
      data.profiles.find((profile) => profile.id === data.currentUserId) ??
      (sessionUser ? userProfile(sessionUser) : data.profiles[0] ?? userProfile({ id: "", email: "" } as User)),
    [data.currentUserId, data.profiles, sessionUser]
  );

  const currentProfileExists = data.profiles.some((profile) => profile.id === currentUser.id);
  const actorId = mode === "supabase" && currentProfileExists ? currentUser.id : null;

  const commit = (next: AppData) => {
    setData(next);
    if (mode === "demo") writeStore(next);
  };

  const loadSupabaseData = async (user: User) => {
    if (!supabase) return;

    const [
      profilesResult,
      patientsResult,
      scansResult,
      aiResultsResult,
      reportsResult,
      auditLogsResult
    ] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: false }),
      supabase.from("patients").select("*").order("created_at", { ascending: false }),
      supabase.from("scans").select("*").order("created_at", { ascending: false }),
      supabase.from("ai_results").select("*").order("created_at", { ascending: false }),
      supabase.from("reports").select("*").order("created_at", { ascending: false }),
      supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100)
    ]);

    const firstError =
      profilesResult.error ??
      patientsResult.error ??
      scansResult.error ??
      aiResultsResult.error ??
      reportsResult.error ??
      auditLogsResult.error;

    if (firstError) throw firstError;

    setMode("supabase");
    const profiles = mergeCurrentProfile(((profilesResult.data ?? []) as DbProfile[]).map(mapProfile), user);
    const currentProfile = profiles.find((profile) => profile.id === user.id) ?? userProfile(user);
    requireApprovedProfile(currentProfile);

    setData({
      currentUserId: user.id,
      profiles,
      patients: ((patientsResult.data ?? []) as DbPatient[]).map(mapPatient),
      scans: ((scansResult.data ?? []) as DbScan[]).map(mapScan),
      aiResults: ((aiResultsResult.data ?? []) as DbAiResult[]).map(mapAiResult),
      reports: ((reportsResult.data ?? []) as DbReport[]).map(mapReport),
      auditLogs: ((auditLogsResult.data ?? []) as DbAuditLog[]).map(mapAuditLog)
    });
  };

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!supabase) {
        const localData = readStore();
        setData(localData);
        writeStore(localData);
        setMode("demo");
        setReady(true);
        return;
      }

      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user || cancelled) {
        setData(emptyData);
        setMode("supabase");
        setReady(true);
        return;
      }

      setSessionUser(authData.user);
      try {
        await loadSupabaseData(authData.user);
      } catch {
        await supabase.auth.signOut();
        setSessionUser(null);
        setData(emptyData);
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    init();

    const subscription = supabase?.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setSessionUser(user);
      if (user) {
        window.setTimeout(() => {
          void loadSupabaseData(user);
        }, 0);
      } else {
        setMode("supabase");
        setData(emptyData);
      }
    });

    return () => {
      cancelled = true;
      subscription?.data.subscription.unsubscribe();
    };
  }, []);

  return {
    ready,
    mode,
    data,
    currentUser,
    async refresh() {
      if (mode === "supabase" && sessionUser) await loadSupabaseData(sessionUser);
    },
    switchRole(role: Role) {
      const profile = data.profiles.find((item) => item.role === role);
      if (!profile) return;
      commit(audit({ ...data, currentUserId: profile.id }, "User login", "profile", profile.id, `${profile.role} demo session`));
    },
    async login(email: string, password: string) {
      if (email.toLowerCase().endsWith(".local")) {
        throw new Error("Demo accounts are disabled on this deployment. Sign in with an approved clinical account.");
      }

      if (!supabase) {
        const profile = data.profiles.find((item) => item.email.toLowerCase() === email.toLowerCase());
        if (!profile) throw new Error("Invalid login.");
        setMode("demo");
        setSessionUser(null);
        commit(audit({ ...data, currentUserId: profile.id }, "User login", "profile", profile.id, `${profile.role} login`));
        return;
      }

      const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });
      const authUser = signInData.session?.user ?? null;

      if (error) throw new Error(error.message);
      if (!authUser) throw new Error("No active Supabase session was returned. Check your email confirmation settings.");

      await ensureProfile(authUser);
      setSessionUser(authUser);
      try {
        await loadSupabaseData(authUser);
      } catch (err) {
        await supabase.auth.signOut();
        setSessionUser(null);
        setData(emptyData);
        throw err;
      }
      await insertAudit(authUser.id, "User login", "profile", authUser.id, "Supabase login");
    },
    async signUp(input: { email: string; password: string; fullName: string; role: Role; department: string; doctorId?: string }) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const normalizedEmail = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(normalizedEmail)) throw new Error("Enter a valid email address.");
      if (input.password.length < 6) throw new Error("Password must be at least 6 characters.");

      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", normalizedEmail)
        .maybeSingle();
      if (existingProfile) {
        throw new Error("An account with this email already exists. Please sign in or use Forgot password.");
      }

      const { data: signUpData, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password: input.password,
        options: {
          data: {
            full_name: input.fullName,
            role: input.role,
            department: input.department,
            doctor_id: input.doctorId || null,
            clinic_name: input.department || "Clinical OCT Service"
          }
        }
      });

      if (error) throw new Error(error.message);
      const identityCount = signUpData.user?.identities?.length ?? 0;
      if (signUpData.user && identityCount === 0) {
        throw new Error("An account with this email already exists. Please sign in or use Forgot password.");
      }
      const authUser = signUpData.session?.user ?? null;
      if (!authUser) {
        throw new Error("Account request submitted. Confirm the email from Supabase, then wait for administrator approval.");
      }

      await ensureProfile(authUser);
      await insertAudit(authUser.id, "User signup", "profile", authUser.id, "Supabase signup");
      await supabase.auth.signOut();
      setSessionUser(null);
      setData(emptyData);
      throw new Error("Account request submitted. Confirm your email if needed, then wait for approval from raahymm@gmail.com.");
    },
    async resetPassword(email: string) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw new Error(error.message);
    },
    async updatePassword(password: string) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },
    async changePassword(currentPassword: string, newPassword: string) {
      if (!supabase) throw new Error("Supabase is not configured.");
      const email = currentUser.email;
      if (!email) throw new Error("No signed-in email was found.");
      if (newPassword.length < 6) throw new Error("New password must be at least 6 characters.");

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (signInError) throw new Error("Current password is incorrect.");

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message);
      await insertAudit(currentUser.id, "Password changed", "profile", currentUser.id, "User changed password internally");
    },
    async logout() {
      if (supabase) await supabase.auth.signOut();
      setMode(supabase ? "supabase" : "demo");
      setSessionUser(null);
      setData(supabase ? emptyData : readStore());
    },
    async createPatient(input: Omit<Patient, "id" | "createdBy" | "createdAt" | "updatedAt">) {
      if (mode === "supabase" && supabase) {
        const { data: row, error } = await supabase
          .from("patients")
          .insert({
            patient_code: input.patientCode,
            cnic: input.cnic || null,
            full_name: input.fullName,
            age: input.age,
            gender: input.gender,
            phone: input.phone || null,
            email: input.email || null,
            address: input.address || null,
            diabetes_history: input.diabetesHistory,
            previous_eye_disease: input.previousEyeDisease || null,
            clinical_notes: input.clinicalNotes || null,
            clinic_id: currentUser.clinicId ?? null,
            department_id: input.departmentId ?? currentUser.defaultDepartmentId ?? null,
            global_patient_key: input.globalPatientKey ?? input.cnic?.replace(/\D/g, "") ?? input.patientCode,
            created_by: actorId
          })
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const patient = mapPatient(row as DbPatient);
        setData((current) => ({ ...current, patients: [patient, ...current.patients] }));
        await insertAudit(actorId, "Patient created", "patient", patient.id, patient.patientCode);
        return patient;
      }

      if (data.patients.some((patient) => patient.patientCode === input.patientCode)) {
        throw new Error("Duplicate patient ID. Please enter a unique MR number.");
      }
      const patient: Patient = {
        ...input,
        id: id("patient"),
        createdBy: currentUser.id,
        createdAt: now(),
        updatedAt: now()
      };
      commit(audit({ ...data, patients: [patient, ...data.patients] }, "Patient created", "patient", patient.id, patient.patientCode));
      return patient;
    },
    async updatePatient(patientId: string, input: Omit<Patient, "id" | "createdBy" | "createdAt" | "updatedAt">) {
      if (mode === "supabase" && supabase) {
        const { data: row, error } = await supabase
          .from("patients")
          .update({
            patient_code: input.patientCode,
            cnic: input.cnic || null,
            full_name: input.fullName,
            age: input.age,
            gender: input.gender,
            phone: input.phone || null,
            email: input.email || null,
            address: input.address || null,
            diabetes_history: input.diabetesHistory,
            previous_eye_disease: input.previousEyeDisease || null,
            clinical_notes: input.clinicalNotes || null,
            clinic_id: input.clinicId ?? currentUser.clinicId ?? null,
            department_id: input.departmentId ?? currentUser.defaultDepartmentId ?? null,
            global_patient_key: input.globalPatientKey ?? input.cnic?.replace(/\D/g, "") ?? input.patientCode,
            updated_at: now()
          })
          .eq("id", patientId)
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const patient = mapPatient(row as DbPatient);
        setData((current) => ({ ...current, patients: current.patients.map((item) => (item.id === patient.id ? patient : item)) }));
        await insertAudit(actorId, "Patient updated", "patient", patient.id, patient.patientCode);
        return patient;
      }

      if (data.patients.some((patient) => patient.patientCode === input.patientCode && patient.id !== patientId)) {
        throw new Error("Duplicate patient ID. Please enter a unique MR number.");
      }

      const existing = data.patients.find((patient) => patient.id === patientId);
      if (!existing) throw new Error("Patient not found.");
      const patient: Patient = {
        ...existing,
        ...input,
        updatedAt: now()
      };
      const patients = data.patients.map((item) => (item.id === patient.id ? patient : item));
      commit(audit({ ...data, patients }, "Patient updated", "patient", patient.id, patient.patientCode));
      return patient;
    },
    async deletePatient(patientId: string) {
      if (mode === "supabase" && supabase) {
        const { error } = await supabase.from("patients").delete().eq("id", patientId);
        if (error) throw new Error(error.message);
        setData((current) => ({
          ...current,
          patients: current.patients.filter((patient) => patient.id !== patientId),
          scans: current.scans.filter((scan) => scan.patientId !== patientId),
          reports: current.reports.filter((report) => report.patientId !== patientId)
        }));
        await insertAudit(actorId, "Patient deleted", "patient", patientId, "Patient and linked records removed");
        return;
      }

      const patientScanIds = data.scans.filter((scan) => scan.patientId === patientId).map((scan) => scan.id);
      const patientReportIds = data.reports.filter((report) => report.patientId === patientId).map((report) => report.id);
      commit(audit({
        ...data,
        patients: data.patients.filter((patient) => patient.id !== patientId),
        scans: data.scans.filter((scan) => scan.patientId !== patientId),
        aiResults: data.aiResults.filter((result) => !patientScanIds.includes(result.scanId)),
        reports: data.reports.filter((report) => report.patientId !== patientId),
        auditLogs: data.auditLogs.filter((log) => !patientReportIds.includes(log.recordId))
      }, "Patient deleted", "patient", patientId, "Patient and linked records removed"));
    },
    async addScan(input: { patientId: string; imageUrl: string; eyeSide: EyeSide; scanNotes?: string; file?: File }) {
      const patient = data.patients.find((item) => item.id === input.patientId);
      if (mode === "supabase" && supabase && input.file) {
        const extension = input.file.name.split(".").pop()?.toLowerCase() || "jpg";
        const storagePath = `${input.patientId}/${crypto.randomUUID()}.${extension}`;
        const upload = await supabase.storage.from("oct-scans").upload(storagePath, input.file, {
          contentType: input.file.type,
          upsert: false
        });
        if (upload.error) throw new Error(upload.error.message);

        const { data: publicUrl } = supabase.storage.from("oct-scans").getPublicUrl(storagePath);
        const { data: row, error } = await supabase
          .from("scans")
          .insert({
            patient_id: input.patientId,
            image_url: publicUrl.publicUrl,
            storage_path: storagePath,
            scan_type: "OCT",
            clinic_id: patient?.clinicId ?? currentUser.clinicId ?? null,
            department_id: patient?.departmentId ?? currentUser.defaultDepartmentId ?? null,
            module_id: "oct",
            eye_side: input.eyeSide,
            scan_notes: input.scanNotes || null,
            uploaded_by: actorId
          })
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const scan = mapScan(row as DbScan);
        setData((current) => ({ ...current, scans: [scan, ...current.scans] }));
        await insertAudit(actorId, "Scan uploaded", "scan", scan.id, storagePath);
        return scan;
      }

      const scan: Scan = {
        id: id("scan"),
        patientId: input.patientId,
        imageUrl: input.imageUrl,
        storagePath: `oct-scans/${input.patientId}/${Date.now()}.jpg`,
        scanType: "OCT",
        clinicId: patient?.clinicId ?? currentUser.clinicId,
        departmentId: patient?.departmentId ?? currentUser.defaultDepartmentId,
        moduleId: "oct",
        eyeSide: input.eyeSide,
        scanNotes: input.scanNotes,
        uploadedBy: currentUser.id,
        createdAt: now()
      };
      commit(audit({ ...data, scans: [scan, ...data.scans] }, "Scan uploaded", "scan", scan.id, "Demo storage path created"));
      return scan;
    },
    async replaceScanImage(scanId: string, file: File) {
      if (currentUser.role !== "doctor" && currentUser.role !== "admin") {
        throw new Error("Only doctors or admins can change scan images.");
      }
      const existing = data.scans.find((scan) => scan.id === scanId);
      if (!existing) throw new Error("Scan not found.");
      const linkedAiIds = data.aiResults.filter((result) => result.scanId === scanId).map((result) => result.id);
      const linkedHeatmapPaths = data.aiResults
        .filter((result) => result.scanId === scanId)
        .map((result) => octScansPublicPath(result.heatmapUrl))
        .filter(Boolean) as string[];

      if (mode === "supabase" && supabase) {
        const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const storagePath = `${existing.patientId}/${crypto.randomUUID()}.${extension}`;
        const upload = await supabase.storage.from("oct-scans").upload(storagePath, file, {
          contentType: file.type,
          upsert: false
        });
        if (upload.error) throw new Error(upload.error.message);

        const { data: publicUrl } = supabase.storage.from("oct-scans").getPublicUrl(storagePath);
        if (linkedAiIds.length) {
          const { error: reportError } = await supabase.from("reports").delete().in("ai_result_id", linkedAiIds);
          if (reportError) throw new Error(reportError.message);
          const { error: aiError } = await supabase.from("ai_results").delete().eq("scan_id", scanId);
          if (aiError) throw new Error(aiError.message);
        }
        const { data: row, error } = await supabase
          .from("scans")
          .update({ image_url: publicUrl.publicUrl, storage_path: storagePath })
          .eq("id", scanId)
          .select("*")
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!row) throw new Error("Scan image was not changed. Supabase may be missing scan update permissions.");

        if (existing.storagePath) {
          await supabase.storage.from("oct-scans").remove([existing.storagePath]);
        }
        if (linkedHeatmapPaths.length) {
          await supabase.storage.from("oct-scans").remove(linkedHeatmapPaths);
        }
        const saved = mapScan(row as DbScan);
        setData((current) => ({
          ...current,
          scans: current.scans.map((scan) => (scan.id === scanId ? saved : scan)),
          aiResults: current.aiResults.filter((result) => result.scanId !== scanId),
          reports: current.reports.filter((report) => !linkedAiIds.includes(report.aiResultId))
        }));
        await insertAudit(actorId, "Scan image changed", "scan", scanId, "Linked analysis and reports removed");
        return saved;
      }

      const imageUrl = URL.createObjectURL(file);
      const saved = {
        ...existing,
        imageUrl,
        storagePath: `oct-scans/${existing.patientId}/${Date.now()}.${file.name.split(".").pop()?.toLowerCase() || "jpg"}`
      };
      commit(audit({
        ...data,
        scans: data.scans.map((scan) => (scan.id === scanId ? saved : scan)),
        aiResults: data.aiResults.filter((result) => result.scanId !== scanId),
        reports: data.reports.filter((report) => !linkedAiIds.includes(report.aiResultId))
      }, "Scan image changed", "scan", scanId, "Linked analysis and reports removed"));
      return saved;
    },
    async deleteScan(scanId: string) {
      if (currentUser.role !== "doctor" && currentUser.role !== "admin") {
        throw new Error("Only doctors or admins can delete scans.");
      }
      const existing = data.scans.find((scan) => scan.id === scanId);
      if (!existing) throw new Error("Scan not found.");
      const linkedAiIds = data.aiResults.filter((result) => result.scanId === scanId).map((result) => result.id);
      const linkedHeatmapPaths = data.aiResults
        .filter((result) => result.scanId === scanId)
        .map((result) => octScansPublicPath(result.heatmapUrl))
        .filter(Boolean) as string[];

      if (mode === "supabase" && supabase) {
        if (linkedAiIds.length) {
          const { error: reportError } = await supabase.from("reports").delete().in("ai_result_id", linkedAiIds);
          if (reportError) throw new Error(reportError.message);
          const { error: aiError } = await supabase.from("ai_results").delete().eq("scan_id", scanId);
          if (aiError) throw new Error(aiError.message);
        }
        const { data: deletedRows, error } = await supabase.from("scans").delete().eq("id", scanId).select("id");
        if (error) throw new Error(error.message);
        if (!deletedRows?.length) throw new Error("Scan was not deleted. Supabase may be missing scan delete permissions.");
        if (existing.storagePath) {
          await supabase.storage.from("oct-scans").remove([existing.storagePath]);
        }
        if (linkedHeatmapPaths.length) {
          await supabase.storage.from("oct-scans").remove(linkedHeatmapPaths);
        }
        setData((current) => ({
          ...current,
          scans: current.scans.filter((scan) => scan.id !== scanId),
          aiResults: current.aiResults.filter((result) => result.scanId !== scanId),
          reports: current.reports.filter((report) => !linkedAiIds.includes(report.aiResultId))
        }));
        await insertAudit(actorId, "Scan deleted", "scan", scanId, "Scan, linked analysis, and reports removed");
        return;
      }

      commit(audit({
        ...data,
        scans: data.scans.filter((scan) => scan.id !== scanId),
        aiResults: data.aiResults.filter((result) => result.scanId !== scanId),
        reports: data.reports.filter((report) => !linkedAiIds.includes(report.aiResultId))
      }, "Scan deleted", "scan", scanId, "Scan, linked analysis, and reports removed"));
    },
    runAnalysis(scan: Scan) {
      const classes: DiseaseClass[] = ["CNV", "DME", "DRUSEN", "NORMAL"];
      const predictedClass = classes[Math.floor(Math.random() * classes.length)];
      const probabilities = normalizeProbabilities(predictedClass);
      const aiResult: AiResult = {
        id: id("ai"),
        scanId: scan.id,
        predictedClass,
        confidence: probabilities[predictedClass],
        probabilities,
        modelName: "EfficientNet-B0",
        modelVersion: "demo-v1.0",
        heatmapUrl: undefined,
        isDummyResult: true,
        createdAt: now()
      };
      const scans = data.scans.some((item) => item.id === scan.id) ? data.scans : [scan, ...data.scans];
      commit(audit({
        ...data,
        scans,
        aiResults: [aiResult, ...data.aiResults.filter((result) => result.scanId !== scan.id)],
        reports: data.reports.filter((report) => report.scanId !== scan.id)
      }, "AI analysis generated", "ai_result", aiResult.id, safetyDisclaimer));
      return aiResult;
    },
    async saveBackendAnalysis(scan: Scan, prediction: BackendPrediction) {
      if (!prediction.is_valid_oct || !isDiseaseClass(prediction.prediction)) {
        throw new Error(prediction.disclaimer);
      }
      const probabilities = prediction.probabilities as Record<DiseaseClass, number>;

      if (mode === "supabase" && supabase) {
        const existingAiIds = data.aiResults.filter((result) => result.scanId === scan.id).map((result) => result.id);
        const oldHeatmapPaths = data.aiResults
          .filter((result) => result.scanId === scan.id)
          .map((result) => octScansPublicPath(result.heatmapUrl))
          .filter(Boolean) as string[];
        if (existingAiIds.length) {
          const { error: reportError } = await supabase.from("reports").delete().in("ai_result_id", existingAiIds);
          if (reportError) throw new Error(reportError.message);
          const { error: aiDeleteError } = await supabase.from("ai_results").delete().eq("scan_id", scan.id);
          if (aiDeleteError) throw new Error(aiDeleteError.message);
        }
        if (oldHeatmapPaths.length) {
          await supabase.storage.from("oct-scans").remove(oldHeatmapPaths);
        }
        let heatmapUrl: string | null = null;
        if (prediction.gradcam_overlay_base64) {
          const heatmapPath = `${scan.patientId}/heatmaps/${scan.id}-${crypto.randomUUID()}.png`;
          const upload = await supabase.storage.from("oct-scans").upload(heatmapPath, dataUrlToBlob(prediction.gradcam_overlay_base64), {
            contentType: "image/png",
            upsert: false
          });
          if (!upload.error) {
            heatmapUrl = supabase.storage.from("oct-scans").getPublicUrl(heatmapPath).data.publicUrl;
          }
        }
        const { data: row, error } = await supabase
          .from("ai_results")
          .insert({
            scan_id: scan.id,
            predicted_class: prediction.prediction,
            confidence: prediction.confidence,
            probabilities,
            model_name: prediction.model_name,
            model_version: prediction.model_version,
            heatmap_url: heatmapUrl,
            module_id: scan.moduleId ?? "oct",
            is_dummy_result: false
          })
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const aiResult = mapAiResult(row as DbAiResult);
        setData((current) => ({
          ...current,
          aiResults: [aiResult, ...current.aiResults.filter((result) => result.scanId !== scan.id)],
          reports: current.reports.filter((report) => report.scanId !== scan.id)
        }));
        await insertAudit(actorId, "AI analysis generated", "ai_result", aiResult.id, prediction.disclaimer);
        return aiResult;
      }

      const aiResult: AiResult = {
        id: id("ai"),
        scanId: scan.id,
        predictedClass: prediction.prediction,
        confidence: prediction.confidence,
        probabilities,
        modelName: prediction.model_name,
        modelVersion: prediction.model_version,
        heatmapUrl: prediction.gradcam_overlay_base64 ?? undefined,
        moduleId: scan.moduleId ?? "oct",
        isDummyResult: false,
        createdAt: now()
      };
      const scans = data.scans.some((item) => item.id === scan.id) ? data.scans : [scan, ...data.scans];
      commit(audit({
        ...data,
        scans,
        aiResults: [aiResult, ...data.aiResults.filter((result) => result.scanId !== scan.id)],
        reports: data.reports.filter((report) => report.scanId !== scan.id)
      }, "AI analysis generated", "ai_result", aiResult.id, prediction.disclaimer));
      return aiResult;
    },
    async createReport(scan: Scan, aiResult: AiResult) {
      const patient = data.patients.find((item) => item.id === scan.patientId);
      const existing = data.reports.find((item) => item.scanId === scan.id && item.aiResultId === aiResult.id);
      if (existing) return existing;

      if (mode === "supabase" && supabase) {
        const template = (await getReportTemplates())[aiResult.predictedClass];
        const { data: row, error } = await supabase
          .from("reports")
          .insert({
            patient_id: scan.patientId,
            scan_id: scan.id,
            ai_result_id: aiResult.id,
            clinic_id: scan.clinicId ?? patient?.clinicId ?? currentUser.clinicId ?? null,
            department_id: scan.departmentId ?? patient?.departmentId ?? currentUser.defaultDepartmentId ?? null,
            module_id: scan.moduleId ?? aiResult.moduleId ?? "oct",
            findings: template.findings,
            impression: template.impression,
            recommendation: template.recommendation,
            doctor_notes: patient?.clinicalNotes ?? "",
            final_diagnosis: "Needs clinical correlation",
            status: "draft",
            created_by: actorId
          })
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const report = mapReport(row as DbReport);
        setData((current) => ({ ...current, reports: [report, ...current.reports] }));
        await insertAudit(actorId, "Report created", "report", report.id, aiResult.predictedClass);
        return report;
      }

      const report: Report = {
        id: id("report"),
        patientId: scan.patientId,
        scanId: scan.id,
        aiResultId: aiResult.id,
        clinicId: scan.clinicId ?? patient?.clinicId ?? currentUser.clinicId,
        departmentId: scan.departmentId ?? patient?.departmentId ?? currentUser.defaultDepartmentId,
        moduleId: scan.moduleId ?? aiResult.moduleId ?? "oct",
        ...(await getReportTemplates())[aiResult.predictedClass],
        doctorNotes: patient?.clinicalNotes ?? "",
        finalDiagnosis: "Needs clinical correlation",
        status: "draft",
        createdBy: currentUser.id,
        createdAt: now(),
        updatedAt: now()
      };
      const scans = data.scans.some((item) => item.id === scan.id) ? data.scans : [scan, ...data.scans];
      const aiResults = data.aiResults.some((item) => item.id === aiResult.id) ? data.aiResults : [aiResult, ...data.aiResults];
      commit(audit({ ...data, scans, aiResults, reports: [report, ...data.reports] }, "Report created", "report", report.id, aiResult.predictedClass));
      return report;
    },
    async saveReport(report: Report) {
      const existing = data.reports.find((item) => item.id === report.id);
      const clinicalStatusChange = report.status === "rejected" || report.status === "superseded";
      if (clinicalStatusChange && currentUser.role !== "doctor") {
        throw new Error("Only doctors can reject or supersede reports.");
      }
      const shouldClearApproval = report.status !== "approved" && existing?.status === "approved";
      const next = {
        ...report,
        approvedBy: shouldClearApproval ? undefined : report.approvedBy,
        approvedAt: shouldClearApproval ? undefined : report.approvedAt,
        updatedAt: now()
      };
      if (mode === "supabase" && supabase) {
        const { data: row, error } = await supabase
          .from("reports")
          .update({
            findings: next.findings,
            impression: next.impression,
            recommendation: next.recommendation,
            doctor_notes: next.doctorNotes,
            final_diagnosis: next.finalDiagnosis,
            status: next.status,
            approved_by: next.approvedBy ?? null,
            approved_at: next.approvedAt ?? null,
            updated_at: next.updatedAt
          })
          .eq("id", next.id)
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const saved = mapReport(row as DbReport);
        setData((current) => ({ ...current, reports: current.reports.map((item) => (item.id === saved.id ? saved : item)) }));
        await insertAudit(actorId, "Report edited", "report", saved.id, saved.status);
        return;
      }

      const reports = data.reports.map((item) => (item.id === report.id ? next : item));
      commit(audit({ ...data, reports }, "Report edited", "report", report.id, report.status));
    },
    async approveReport(report: Report) {
      if (currentUser.role !== "doctor") {
        throw new Error("Only doctors can approve reports.");
      }
      const aiResult = data.aiResults.find((item) => item.id === report.aiResultId);
      const approved: Report = {
        ...report,
        finalDiagnosis:
          report.finalDiagnosis === "Needs clinical correlation" && aiResult
            ? aiResult.predictedClass
            : report.finalDiagnosis,
        status: "approved",
        approvedBy: actorId ?? currentUser.id,
        approvedAt: now(),
        updatedAt: now()
      };

      if (mode === "supabase" && supabase) {
        const { data: row, error } = await supabase
          .from("reports")
          .update({
            final_diagnosis: approved.finalDiagnosis,
            status: "approved",
            approved_by: actorId,
            approved_at: approved.approvedAt,
            updated_at: approved.updatedAt
          })
          .eq("id", report.id)
          .select("*")
          .single();

        if (error) throw new Error(error.message);
        const saved = mapReport(row as DbReport);
        setData((current) => ({ ...current, reports: current.reports.map((item) => (item.id === saved.id ? saved : item)) }));
        await insertAudit(actorId, "Report approved", "report", saved.id, currentUser.fullName);
        return saved;
      }

      const reports = data.reports.map((item) => (item.id === report.id ? approved : item));
      commit(audit({ ...data, reports }, "Report approved", "report", report.id, currentUser.fullName));
      return approved;
    },
    async deleteReport(reportId: string) {
      if (currentUser.role !== "doctor" && currentUser.role !== "admin") {
        throw new Error("Only doctors can delete reports.");
      }
      if (mode === "supabase" && supabase) {
        const { error } = await supabase.from("reports").delete().eq("id", reportId);
        if (error) throw new Error(error.message);
        setData((current) => ({ ...current, reports: current.reports.filter((report) => report.id !== reportId) }));
        await insertAudit(actorId, "Report deleted", "report", reportId, "Report removed by clinical user");
        return;
      }
      commit(audit({ ...data, reports: data.reports.filter((report) => report.id !== reportId) }, "Report deleted", "report", reportId, "Report removed"));
    },
    async deleteAnalysis(aiResultId: string) {
      if (currentUser.role !== "doctor" && currentUser.role !== "admin") {
        throw new Error("Only doctors or admins can delete analyses.");
      }
      const linkedReports = data.reports.filter((report) => report.aiResultId === aiResultId);
      const heatmapPath = octScansPublicPath(data.aiResults.find((result) => result.id === aiResultId)?.heatmapUrl);
      if (mode === "supabase" && supabase) {
        if (linkedReports.length) {
          const { error: reportError } = await supabase.from("reports").delete().eq("ai_result_id", aiResultId);
          if (reportError) throw new Error(reportError.message);
        }
        const { error } = await supabase.from("ai_results").delete().eq("id", aiResultId);
        if (error) throw new Error(error.message);
        if (heatmapPath) {
          await supabase.storage.from("oct-scans").remove([heatmapPath]);
        }
        setData((current) => ({
          ...current,
          reports: current.reports.filter((report) => report.aiResultId !== aiResultId),
          aiResults: current.aiResults.filter((result) => result.id !== aiResultId)
        }));
        await insertAudit(actorId, "Analysis deleted", "ai_result", aiResultId, "AI analysis removed by clinical user");
        return;
      }
      commit(audit({
        ...data,
        reports: data.reports.filter((report) => report.aiResultId !== aiResultId),
        aiResults: data.aiResults.filter((result) => result.id !== aiResultId)
      }, "Analysis deleted", "ai_result", aiResultId, "AI analysis removed"));
    },
    async updateProfileAccess(profileId: string, input: { role?: Role; isActive?: boolean }) {
      if (currentUser.email.toLowerCase() !== SUPER_ADMIN_EMAIL) {
        throw new Error("Only raahymm@gmail.com can approve clinical access.");
      }
      if (!supabase || mode !== "supabase") {
        const profiles = data.profiles.map((profile) =>
          profile.id === profileId
            ? { ...profile, role: input.role ?? profile.role, isActive: input.isActive ?? profile.isActive }
            : profile
        );
        commit(audit({ ...data, profiles }, "User access updated", "profile", profileId, "Local access update"));
        return;
      }

      const updates: { role?: Role; is_active?: boolean } = {};
      if (input.role) updates.role = input.role;
      if (typeof input.isActive === "boolean") updates.is_active = input.isActive;

      const { data: row, error } = await supabase
        .from("profiles")
        .update(updates)
        .eq("id", profileId)
        .select("*")
        .single();

      if (error) throw new Error(error.message);
      const saved = mapProfile(row as DbProfile);
      setData((current) => ({
        ...current,
        profiles: current.profiles.map((profile) => (profile.id === saved.id ? saved : profile))
      }));
      await insertAudit(actorId, "User access updated", "profile", saved.id, `${saved.role} / ${saved.isActive ? "approved" : "suspended"}`);
    },
    resetDemo() {
      commit(seedData);
    }
  };
}

export function getStatusLabel(status: Report["status"]) {
  return status.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
