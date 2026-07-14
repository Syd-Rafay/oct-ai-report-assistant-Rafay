import type { ClinicalClass, DiseaseClass, ModuleId } from "./types";
import { supabase } from "./supabase";

export const safetyDisclaimer =
  "Preliminary screening result. Requires doctor review.";

export const finalReportDisclaimer =
  "This report was prepared with screening support and reviewed by a qualified clinician. The screening output is not a standalone diagnosis.";

export const approvedReportDisclaimer =
  "This report was reviewed by a qualified clinician and should be interpreted with the full clinical context.";

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
      "The OCT image does not show obvious abnormal features on screening review.",
    impression: "Screening classification suggests a normal OCT pattern.",
    recommendation:
      "Routine clinical review is advised if symptoms persist or if clinical suspicion remains."
  },
  CNV: {
    findings:
      "The OCT image shows features suggestive of choroidal neovascularization.",
    impression:
      "Screening classification suggests CNV. This may require retinal specialist review.",
    recommendation:
      "Ophthalmologist confirmation and further retinal evaluation are advised."
  },
  DME: {
    findings:
      "The OCT image shows features suggestive of diabetic macular edema.",
    impression:
      "Screening classification suggests DME. Clinical correlation with diabetic history is recommended.",
    recommendation:
      "Ophthalmologist review and correlation with patient history, visual acuity, and fundus examination are advised."
  },
  DRUSEN: {
    findings:
      "The OCT image shows features suggestive of drusen-related retinal changes.",
    impression:
      "Screening classification suggests DRUSEN. This may be associated with age-related macular changes.",
    recommendation:
      "Further ophthalmic evaluation and monitoring may be considered."
  },
  KCN: {
    findings:
      "The VKG/topography image shows screening features that may be consistent with keratoconus risk.",
    impression:
      "VKG screening suggests KCN. Corneal specialist review and clinical correlation are required.",
    recommendation:
      "Review tomography/topography indices, refraction, visual acuity, slit-lamp findings, and progression history. Consider corneal specialist referral if clinically indicated."
  },
  SUSPECT: {
    findings:
      "The VKG/topography image shows borderline or mixed screening features.",
    impression:
      "VKG screening suggests a suspect / borderline corneal topography pattern.",
    recommendation:
      "Repeat or verify image quality, compare with prior topography if available, and review clinically before confirming disease or normal status."
  },
  NO_DR: {
    findings: "The combined fundus screening did not show screening features of diabetic retinopathy. Glaucoma and hypertensive-retinopathy outputs should be reviewed in the result summary.",
    impression: "Fundus screening suggests no diabetic retinopathy.",
    recommendation: "Review the glaucoma CDR/risk and hypertensive-retinopathy status from the model summary, then continue routine diabetic eye screening if clinically appropriate."
  },
  MILD_DR: {
    findings: "The combined fundus screening shows mild screening features that may be consistent with early diabetic retinopathy. Glaucoma and hypertensive-retinopathy outputs should be reviewed in the result summary.",
    impression: "Fundus screening suggests mild diabetic retinopathy.",
    recommendation: "Review the glaucoma CDR/risk and hypertensive-retinopathy status, optimise systemic risk factors, and plan follow-up after clinician review."
  },
  MODERATE_DR: {
    findings: "The combined fundus screening shows moderate screening features of diabetic retinopathy. Glaucoma and hypertensive-retinopathy outputs should be reviewed in the result summary.",
    impression: "Fundus screening suggests moderate diabetic retinopathy.",
    recommendation: "Ophthalmology review is advised, with correlation against visual acuity, fundus examination, glaucoma risk, hypertensive-retinopathy status, and diabetic history."
  },
  SEVERE_DR: {
    findings: "The combined fundus screening shows severe screening features of diabetic retinopathy. Glaucoma and hypertensive-retinopathy outputs should be reviewed in the result summary.",
    impression: "Fundus screening suggests severe diabetic retinopathy.",
    recommendation: "Urgent ophthalmology referral is advised after clinician confirmation, especially if glaucoma or hypertensive-retinopathy outputs are also abnormal."
  },
  PROLIFERATIVE_DR: {
    findings: "The combined fundus screening shows screening features concerning for proliferative diabetic retinopathy. Glaucoma and hypertensive-retinopathy outputs should be reviewed in the result summary.",
    impression: "Fundus screening suggests proliferative diabetic retinopathy.",
    recommendation: "Emergency or urgent retinal specialist review is advised after clinician confirmation, with attention to concurrent glaucoma or hypertensive-retinopathy risk."
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
