export type Role = "admin" | "doctor" | "assistant";
export type RequestedRole = Role;
export type Gender = "Female" | "Male" | "Other";
export type EyeSide = "Left" | "Right" | "Both" | "Unknown";
export type DiseaseClass = "CNV" | "DME" | "DRUSEN" | "NORMAL";
export type PredictionClass = DiseaseClass | "INVALID_IMAGE" | "INVALID_OR_UNCERTAIN_IMAGE";
export type ReportStatus = "draft" | "pending_review" | "approved" | "rejected";

export type Profile = {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  doctorId?: string;
  specialization?: string;
  clinicName?: string;
  isActive: boolean;
};

export type Patient = {
  id: string;
  patientCode: string;
  fullName: string;
  age: number;
  gender: Gender;
  phone?: string;
  email?: string;
  address?: string;
  diabetesHistory: "Yes" | "No" | "Unknown";
  previousEyeDisease?: string;
  clinicalNotes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type Scan = {
  id: string;
  patientId: string;
  imageUrl: string;
  storagePath: string;
  scanType: "OCT";
  eyeSide: EyeSide;
  scanNotes?: string;
  uploadedBy: string;
  createdAt: string;
};

export type AiResult = {
  id: string;
  scanId: string;
  predictedClass: DiseaseClass;
  confidence: number;
  probabilities: Record<DiseaseClass, number>;
  modelName: string;
  modelVersion: string;
  isDummyResult: boolean;
  createdAt: string;
};

export type BackendPrediction = {
  prediction: PredictionClass;
  confidence: number;
  probabilities: Partial<Record<DiseaseClass, number>>;
  model_name: string;
  model_version: string;
  is_valid_oct?: boolean;
  disclaimer: string;
};

export function isDiseaseClass(value: PredictionClass): value is DiseaseClass {
  return value === "CNV" || value === "DME" || value === "DRUSEN" || value === "NORMAL";
}

export type Report = {
  id: string;
  patientId: string;
  scanId: string;
  aiResultId: string;
  findings: string;
  impression: string;
  recommendation: string;
  doctorNotes: string;
  finalDiagnosis: DiseaseClass | "Needs clinical correlation";
  status: ReportStatus;
  approvedBy?: string;
  pdfUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export type AuditLog = {
  id: string;
  userId: string;
  action: string;
  recordType: string;
  recordId: string;
  details: string;
  createdAt: string;
};

export type FeedbackEntry = {
  id: string;
  type: "feedback" | "complaint";
  name: string;
  email?: string;
  phone?: string;
  patientCode?: string;
  reportId?: string;
  message: string;
  status: "new" | "reviewing" | "resolved";
  createdAt: string;
};

export type AppData = {
  currentUserId: string;
  profiles: Profile[];
  patients: Patient[];
  scans: Scan[];
  aiResults: AiResult[];
  reports: Report[];
  auditLogs: AuditLog[];
};
