import { Activity, Eye, Layers3, ScanEye } from "lucide-react";

export type ClinicalModuleId = "oct" | "vkg" | "corneal" | "retina";

export type ClinicalModule = {
  id: ClinicalModuleId;
  name: string;
  department: string;
  shortName: string;
  status: "live" | "training" | "awaiting_model";
  description: string;
  route?: string;
  accent: string;
  icon: typeof Eye;
};

export const clinicalModules: ClinicalModule[] = [
  {
    id: "oct",
    name: "OCT Report Assistant",
    department: "OCT Department",
    shortName: "OCT",
    status: "live",
    description: "Macular OCT upload, AI-assisted classification, doctor review, and report generation.",
    route: "/modules/oct",
    accent: "bg-cyan-50 text-cyan-800 ring-cyan-200",
    icon: ScanEye
  },
  {
    id: "vkg",
    name: "VKG Topography Screening",
    department: "VKG Department",
    shortName: "VKG",
    status: "training",
    description: "Corneal topography/VKG keratoconus screening workflow with separate patients, scans, templates, and reports.",
    route: "/modules/vkg",
    accent: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    icon: Activity
  },
  {
    id: "corneal",
    name: "Corneal Screening",
    department: "Corneal Department",
    shortName: "Corneal",
    status: "training",
    description: "Keratoconus/corneal screening module, sold separately from OCT/VKG.",
    accent: "bg-amber-50 text-amber-800 ring-amber-200",
    icon: Layers3
  },
  {
    id: "retina",
    name: "Retinal Fundus Screening",
    department: "Retina Department",
    shortName: "Retina",
    status: "awaiting_model",
    description: "Retinal fundus module for DR/glaucoma-style reports once its model/API is available.",
    accent: "bg-violet-50 text-violet-800 ring-violet-200",
    icon: Eye
  }
];

export function getEnabledModuleIds(): ClinicalModuleId[] {
  const raw = process.env.NEXT_PUBLIC_AFIO_ENABLED_MODULES ?? "oct,vkg";
  const requested = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const validIds = new Set(clinicalModules.map((module) => module.id));
  const enabled = requested.filter((item): item is ClinicalModuleId => validIds.has(item as ClinicalModuleId));
  return enabled.length ? enabled : ["oct"];
}

export function isModuleEnabled(id: ClinicalModuleId) {
  return getEnabledModuleIds().includes(id);
}

export function getEnabledModules() {
  const enabled = new Set(getEnabledModuleIds());
  return clinicalModules.filter((module) => enabled.has(module.id));
}

export function getModulesByIds(ids: ClinicalModuleId[]) {
  const enabled = new Set(ids);
  return clinicalModules.filter((module) => enabled.has(module.id));
}
