import type { ClinicalClass, DiseaseClass, ModuleId } from "./types";
import { supabase } from "./supabase";

export const safetyDisclaimer =
  "AI-assisted preliminary result. Requires doctor review.";

export const finalReportDisclaimer =
  "This report was generated with AI assistance and reviewed by a qualified clinician. The AI output is not a standalone diagnosis.";

export type ReportTemplate = {
  findings: string;
  impression: string;
  recommendation: string;
};

export const reportTemplates: Record<
  ClinicalClass,
  ReportTemplate
> = {
  NORMAL: {
    findings:
      "The OCT image does not show obvious abnormal features based on AI-assisted analysis.",
    impression: "AI-assisted classification suggests a normal OCT pattern.",
    recommendation:
      "Routine clinical review is advised if symptoms persist or if clinical suspicion remains."
  },
  CNV: {
    findings:
      "The OCT image shows features suggestive of choroidal neovascularization.",
    impression:
      "AI-assisted classification suggests CNV. This may require retinal specialist review.",
    recommendation:
      "Ophthalmologist confirmation and further retinal evaluation are advised."
  },
  DME: {
    findings:
      "The OCT image shows features suggestive of diabetic macular edema.",
    impression:
      "AI-assisted classification suggests DME. Clinical correlation with diabetic history is recommended.",
    recommendation:
      "Ophthalmologist review and correlation with patient history, visual acuity, and fundus examination are advised."
  },
  DRUSEN: {
    findings:
      "The OCT image shows features suggestive of drusen-related retinal changes.",
    impression:
      "AI-assisted classification suggests DRUSEN. This may be associated with age-related macular changes.",
    recommendation:
      "Further ophthalmic evaluation and monitoring may be considered."
  },
  KCN: {
    findings:
      "The VKG/topography image shows AI-screening features that may be consistent with keratoconus risk.",
    impression:
      "AI-assisted VKG screening suggests KCN. Corneal specialist review and clinical correlation are required.",
    recommendation:
      "Review tomography/topography indices, refraction, visual acuity, slit-lamp findings, and progression history. Consider corneal specialist referral if clinically indicated."
  },
  SUSPECT: {
    findings:
      "The VKG/topography image shows borderline or mixed AI-screening features.",
    impression:
      "AI-assisted VKG screening suggests a suspect / borderline corneal topography pattern.",
    recommendation:
      "Repeat or verify image quality, compare with prior topography if available, and review clinically before confirming disease or normal status."
  },
  NO_DR: {
    findings: "The fundus image does not show AI-screening features of diabetic retinopathy.",
    impression: "AI-assisted fundus screening suggests no diabetic retinopathy.",
    recommendation: "Routine diabetic eye screening and clinician review are advised."
  },
  MILD_DR: {
    findings: "The fundus image shows mild AI-screening features that may be consistent with early diabetic retinopathy.",
    impression: "AI-assisted fundus screening suggests mild diabetic retinopathy.",
    recommendation: "Clinical review, glycaemic control optimisation, and follow-up screening are advised."
  },
  MODERATE_DR: {
    findings: "The fundus image shows moderate AI-screening features of diabetic retinopathy.",
    impression: "AI-assisted fundus screening suggests moderate diabetic retinopathy.",
    recommendation: "Ophthalmology review and correlation with visual acuity, fundus examination, and diabetic history are advised."
  },
  SEVERE_DR: {
    findings: "The fundus image shows severe AI-screening features of diabetic retinopathy.",
    impression: "AI-assisted fundus screening suggests severe diabetic retinopathy.",
    recommendation: "Urgent ophthalmology referral is advised after clinician confirmation."
  },
  PROLIFERATIVE_DR: {
    findings: "The fundus image shows AI-screening features concerning for proliferative diabetic retinopathy.",
    impression: "AI-assisted fundus screening suggests proliferative diabetic retinopathy.",
    recommendation: "Emergency or urgent retinal specialist review is advised after clinician confirmation."
  }
};

const TEMPLATE_STORAGE_KEY = "oct-ai-report-assistant-report-templates-v2";

type DbReportTemplate = {
  disease_class: ClinicalClass;
  module_id?: ModuleId | null;
  findings: string | null;
  impression: string | null;
  recommendation: string | null;
};

function classesForModule(moduleId: ModuleId): ClinicalClass[] {
  if (moduleId === "retina") return ["NO_DR", "MILD_DR", "MODERATE_DR", "SEVERE_DR", "PROLIFERATIVE_DR"];
  return moduleId === "vkg" ? ["NORMAL", "KCN", "SUSPECT"] : ["NORMAL", "CNV", "DME", "DRUSEN"];
}

export function reportClassesForModule(moduleId: ModuleId): ClinicalClass[] {
  return classesForModule(moduleId);
}

function readLocalReportTemplates(moduleId: ModuleId = "oct") {
  if (typeof window === "undefined") return reportTemplates;
  const raw = window.localStorage.getItem(`${TEMPLATE_STORAGE_KEY}-${moduleId}`);
  if (!raw) return reportTemplates;
  try {
    return { ...reportTemplates, ...(JSON.parse(raw) as Partial<Record<ClinicalClass, ReportTemplate>>) };
  } catch {
    return reportTemplates;
  }
}

function writeLocalReportTemplates(templates: Record<ClinicalClass, ReportTemplate>, moduleId: ModuleId = "oct") {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${TEMPLATE_STORAGE_KEY}-${moduleId}`, JSON.stringify(templates));
}

function mapTemplateRows(rows: DbReportTemplate[]) {
  const savedTemplates = rows.reduce((acc, row) => {
    acc[row.disease_class] = {
      findings: row.findings ?? "",
      impression: row.impression ?? "",
      recommendation: row.recommendation ?? ""
    };
    return acc;
  }, {} as Partial<Record<ClinicalClass, ReportTemplate>>);

  return { ...reportTemplates, ...savedTemplates };
}

export async function getReportTemplates(moduleId: ModuleId = "oct") {
  if (!supabase) return readLocalReportTemplates(moduleId);

  const { data, error } = await supabase
    .from("report_templates")
    .select("disease_class,module_id,findings,impression,recommendation")
    .or(`module_id.is.null,module_id.eq.${moduleId}`)
    .order("disease_class", { ascending: true });

  if (error) {
    console.warn("Could not load report templates from Supabase.", error.message);
    return readLocalReportTemplates(moduleId);
  }

  const templates = mapTemplateRows((data ?? []) as DbReportTemplate[]);
  writeLocalReportTemplates(templates, moduleId);
  return templates;
}

export async function saveReportTemplates(templates: Record<ClinicalClass, ReportTemplate>, moduleId: ModuleId = "oct") {
  writeLocalReportTemplates(templates, moduleId);
  if (!supabase) return;

  const rows = classesForModule(moduleId).map((diseaseClass) => ({
    ...templates[diseaseClass],
    disease_class: diseaseClass,
    module_id: moduleId,
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase.from("report_templates").upsert(rows, { onConflict: "module_id,disease_class" });
  if (error) throw new Error(error.message);
}
