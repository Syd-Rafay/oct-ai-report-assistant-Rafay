import type { DiseaseClass } from "./types";
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
  DiseaseClass,
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
  }
};

const TEMPLATE_STORAGE_KEY = "oct-ai-report-assistant-report-templates-v1";

type DbReportTemplate = {
  disease_class: DiseaseClass;
  findings: string | null;
  impression: string | null;
  recommendation: string | null;
};

function readLocalReportTemplates() {
  if (typeof window === "undefined") return reportTemplates;
  const raw = window.localStorage.getItem(TEMPLATE_STORAGE_KEY);
  if (!raw) return reportTemplates;
  try {
    return { ...reportTemplates, ...(JSON.parse(raw) as Partial<Record<DiseaseClass, ReportTemplate>>) };
  } catch {
    return reportTemplates;
  }
}

function writeLocalReportTemplates(templates: Record<DiseaseClass, ReportTemplate>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function mapTemplateRows(rows: DbReportTemplate[]) {
  const savedTemplates = rows.reduce((acc, row) => {
    acc[row.disease_class] = {
      findings: row.findings ?? "",
      impression: row.impression ?? "",
      recommendation: row.recommendation ?? ""
    };
    return acc;
  }, {} as Partial<Record<DiseaseClass, ReportTemplate>>);

  return { ...reportTemplates, ...savedTemplates };
}

export async function getReportTemplates() {
  if (!supabase) return readLocalReportTemplates();

  const { data, error } = await supabase
    .from("report_templates")
    .select("disease_class,findings,impression,recommendation")
    .order("disease_class", { ascending: true });

  if (error) {
    console.warn("Could not load report templates from Supabase.", error.message);
    return readLocalReportTemplates();
  }

  const templates = mapTemplateRows((data ?? []) as DbReportTemplate[]);
  writeLocalReportTemplates(templates);
  return templates;
}

export async function saveReportTemplates(templates: Record<DiseaseClass, ReportTemplate>) {
  writeLocalReportTemplates(templates);
  if (!supabase) return;

  const rows = Object.entries(templates).map(([diseaseClass, template]) => ({
    disease_class: diseaseClass,
    findings: template.findings,
    impression: template.impression,
    recommendation: template.recommendation,
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase.from("report_templates").upsert(rows, { onConflict: "disease_class" });
  if (error) throw new Error(error.message);
}
