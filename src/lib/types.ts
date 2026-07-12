export type Role = "afio_admin" | "hospital_admin" | "admin" | "doctor" | "assistant";
export type RequestedRole = Role;
export type Gender = "Female" | "Male" | "Other";
export type EyeSide = "Left" | "Right" | "Both" | "Unknown";
export type ModuleId = "oct" | "vkg" | "corneal" | "retina";
export type DiseaseClass = "CNV" | "DME" | "DRUSEN" | "NORMAL";
export type VkgClass = "NORMAL" | "KCN" | "SUSPECT";
export type RetinaClass = "NO_DR" | "MILD_DR" | "MODERATE_DR" | "SEVERE_DR" | "PROLIFERATIVE_DR";
export type ClinicalClass = DiseaseClass | VkgClass | RetinaClass;
export type PredictionClass = ClinicalClass | "INVALID_IMAGE" | "INVALID_OR_UNCERTAIN_IMAGE";
export type ReportStatus = "draft" | "pending_review" | "approved" | "rejected" | "superseded";

export type Profile = {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  doctorId?: string;
  specialization?: string;
  clinicName?: string;
  clinicId?: string;
  defaultDepartmentId?: string;
  isActive: boolean;
};

export type Hospital = {
  id: string;
  name: string;
  code: string;
  adminEmail?: string;
  subscriptionStatus: "trial" | "active" | "past_due" | "suspended";
  isActive: boolean;
  allowSelfSignup: boolean;
  enabledModules: ModuleId[];
  createdAt: string;
};

export type Patient = {
  id: string;
  patientCode: string;
  cnic?: string;
  accessPassword?: string;
  fullName: string;
  age: number;
  gender: Gender;
  phone?: string;
  email?: string;
  address?: string;
  diabetesHistory: "Yes" | "No" | "Unknown";
  previousEyeDisease?: string;
  clinicalNotes?: string;
  clinicId?: string;
  departmentId?: string;
  moduleId?: ModuleId;
  globalPatientKey?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type Scan = {
  id: string;
  patientId: string;
  imageUrl: string;
  storagePath: string;
  scanType: "OCT" | "VKG" | "CORNEAL" | "RETINA";
  clinicId?: string;
  departmentId?: string;
  moduleId?: ModuleId;
  eyeSide: EyeSide;
  scanNotes?: string;
  uploadedBy: string;
  createdAt: string;
};

export type AiResult = {
  id: string;
  scanId: string;
  predictedClass: ClinicalClass;
  confidence: number;
  probabilities: Partial<Record<ClinicalClass, number>>;
  modelName: string;
  modelVersion: string;
  heatmapUrl?: string;
  moduleId?: ModuleId;
  isDummyResult: boolean;
  createdAt: string;
};

export type BackendPrediction = {
  prediction: PredictionClass;
  confidence: number;
  probabilities: Partial<Record<ClinicalClass, number>>;
  model_name: string;
  model_version: string;
  models_used?: string[];
  is_valid_oct?: boolean;
  is_valid_corneal?: boolean;
  quality_metrics?: Record<string, number | boolean | string>;
  validation_warnings?: string[];
  gradcam_overlay_base64?: string | null;
  gradcam_disclaimer?: string;
  disclaimer: string;
  request_time_ms?: number;
  inference_time_ms?: number;
};

export function isDiseaseClass(value: PredictionClass): value is DiseaseClass {
  return value === "CNV" || value === "DME" || value === "DRUSEN" || value === "NORMAL";
}

export function isClinicalClass(value: PredictionClass): value is ClinicalClass {
  return (
    value === "CNV" ||
    value === "DME" ||
    value === "DRUSEN" ||
    value === "NORMAL" ||
    value === "KCN" ||
    value === "SUSPECT" ||
    value === "NO_DR" ||
    value === "MILD_DR" ||
    value === "MODERATE_DR" ||
    value === "SEVERE_DR" ||
    value === "PROLIFERATIVE_DR"
  );
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
  finalDiagnosis: ClinicalClass | "Needs clinical correlation";
  clinicId?: string;
  departmentId?: string;
  moduleId?: ModuleId;
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
  clinicId?: string;
  hospitalName?: string;
  moduleId?: ModuleId;
  name: string;
  email?: string;
  phone?: string;
  patientCode?: string;
  reportId?: string;
  message: string;
  status: "new" | "reviewing" | "resolved";
  createdAt: string;
  responses?: FeedbackResponse[];
};

export type FeedbackResponse = {
  id: string;
  message: string;
  responderName: string;
  createdAt: string;
};

export type AppData = {
  currentUserId: string;
  hospitals: Hospital[];
  profiles: Profile[];
  patients: Patient[];
  scans: Scan[];
  aiResults: AiResult[];
  reports: Report[];
  auditLogs: AuditLog[];
};
