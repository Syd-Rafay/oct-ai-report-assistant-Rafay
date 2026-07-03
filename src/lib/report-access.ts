import type { DiseaseClass, Report } from "./types";

const ACCESS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function fnv1a(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getReportAccessPassword(report: Pick<Report, "id" | "createdAt">) {
  let value = fnv1a(`${report.id}:${report.createdAt}`);
  let password = "";
  for (let index = 0; index < 7; index += 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    password += ACCESS_ALPHABET[value % ACCESS_ALPHABET.length];
  }
  return password;
}

export type PublicReportResult = {
  configured?: boolean;
  found: boolean;
  approved: boolean;
  status?: Report["status"];
  message?: string;
  report?: {
    id: string;
    patientCode: string;
    patientName: string;
    age?: number;
    gender?: string;
    predictedClass?: DiseaseClass;
    confidence?: number;
    findings: string;
    impression: string;
    recommendation: string;
    doctorNotes: string;
    finalDiagnosis: string;
    approvedAt?: string;
  };
};

function backendBaseUrl() {
  const backendUrl = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  if (!backendUrl) throw new Error("NEXT_PUBLIC_AI_BACKEND_URL is missing.");
  return backendUrl.replace(/\/$/, "");
}

export async function checkPublicReport(reportId: string, password: string): Promise<PublicReportResult> {
  const response = await fetch(`${backendBaseUrl()}/reports/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report_id: reportId, password })
  });

  if (!response.ok) {
    let detail = "Could not check report access.";
    try {
      const body = await response.json();
      detail = body.detail ?? detail;
    } catch {
      // Keep default message.
    }
    throw new Error(detail);
  }

  return response.json();
}

export async function sendReportAccessEmail(input: {
  toEmail: string;
  patientName: string;
  reportId: string;
  password: string;
}) {
  const response = await fetch(`${backendBaseUrl()}/reports/send-access-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to_email: input.toEmail,
      patient_name: input.patientName,
      report_id: input.reportId,
      password: input.password
    })
  });

  if (!response.ok) {
    let detail = "Could not send report access email.";
    try {
      const body = await response.json();
      detail = body.detail ?? detail;
    } catch {
      // Keep default message.
    }
    throw new Error(detail);
  }

  return response.json() as Promise<{ sent: boolean; configured: boolean; message: string }>;
}
