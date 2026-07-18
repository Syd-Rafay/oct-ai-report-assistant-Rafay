import type { BackendPrediction } from "./types";
import { supabase } from "./supabase";

export type RetinaServiceSelection = {
  dr: boolean;
  glaucoma: boolean;
  hr: boolean;
};

export type RetinaPredictionOptions = {
  services?: RetinaServiceSelection;
  imageQualityWarnings?: string[];
};

async function postImagePrediction(file: File, backendUrl: string | undefined, missingMessage: string, fieldName = "file"): Promise<BackendPrediction> {
  if (!backendUrl) {
    throw new Error(missingMessage);
  }

  const formData = new FormData();
  formData.append(fieldName, file);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/predict`, {
      method: "POST",
      body: formData
    });
  } catch (error) {
    throw new Error(
      "Could not reach the AI backend. Check your internet connection, Render backend status, or CORS settings."
    );
  }

  if (!response.ok) {
    let detail = "AI prediction failed.";
    try {
      const body = await response.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Keep the generic message if the backend did not return JSON.
    }
    throw new Error(detail);
  }

  const prediction = (await response.json()) as BackendPrediction;
  return {
    ...prediction,
    request_time_ms: Math.round(performance.now() - startedAt),
  };
}

async function postImageEndpoint(file: File, endpointUrl: string | undefined, missingMessage: string, fieldName = "file"): Promise<BackendPrediction> {
  if (!endpointUrl) {
    throw new Error(missingMessage);
  }

  const formData = new FormData();
  formData.append(fieldName, file);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: "POST",
      body: formData
    });
  } catch {
    throw new Error(`Could not reach ${endpointUrl}. Check Render status, CORS, or whether the free service is waking up.`);
  }

  if (!response.ok) {
    let detail = "AI prediction failed.";
    try {
      const body = await response.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Keep the generic message if the backend did not return JSON.
    }
    throw new Error(detail);
  }

  const prediction = (await response.json()) as BackendPrediction;
  return {
    ...prediction,
    request_time_ms: Math.round(performance.now() - startedAt),
  };
}

async function currentSupabaseJwt() {
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function postOctGatewayPrediction(file: File): Promise<BackendPrediction> {
  const token = await currentSupabaseJwt();
  if (!token) {
    throw new Error("You must be signed in to run OCT analysis.");
  }

  const formData = new FormData();
  formData.append("file", file);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch("/api/ai/oct", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });
  } catch {
    throw new Error("Could not reach the OCT gateway. Check your connection or application status.");
  }

  if (!response.ok) {
    let detail = "AI prediction failed.";
    try {
      const body = await response.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Keep the generic message if the gateway did not return JSON.
    }
    throw new Error(detail);
  }

  const prediction = (await response.json()) as BackendPrediction;
  return {
    ...prediction,
    request_time_ms: Math.round(performance.now() - startedAt),
  };
}

export async function predictOCT(file: File): Promise<BackendPrediction> {
  return postOctGatewayPrediction(file);
}

export async function predictOCTWithGradcam(file: File): Promise<BackendPrediction> {
  return postOctGatewayPrediction(file);
}

export async function predictCorneal(file: File): Promise<BackendPrediction> {
  return predictVKG(file);
}

export async function predictCornealUlcer(file: File): Promise<BackendPrediction> {
  // Keep this backend split from the existing corneal ensemble services.
  const backendUrl = process.env.NEXT_PUBLIC_CORNEAL_ULCER_BACKEND_URL?.replace(/\/$/, "");
  return postImagePrediction(
    file,
    backendUrl,
    "Corneal ulcer disease backend is not connected. Add NEXT_PUBLIC_CORNEAL_ULCER_BACKEND_URL in Vercel/Render before running this screening."
  );
}

export async function predictVKG(file: File): Promise<BackendPrediction> {
  const backendUrls = uniqueUrls([
    process.env.NEXT_PUBLIC_VKG_BACKEND_URL,
    process.env.NEXT_PUBLIC_CORNEAL_BACKEND_URL,
    process.env.NEXT_PUBLIC_CORNEAL_RESNET_BACKEND_URL,
    process.env.NEXT_PUBLIC_CORNEAL_DENSENET_BACKEND_URL,
    process.env.NEXT_PUBLIC_CORNEAL_EFFICIENTNET_BACKEND_URL,
  ]);
  if (backendUrls.length > 1) {
    return normalizeVkgEnsemblePrediction(
      await Promise.all(backendUrls.map((url) => postImagePrediction(file, url, "A configured VKG backend URL is missing.")))
    );
  }
  if (backendUrls.length === 1) {
    return normalizeVkgPrediction(await postImagePrediction(file, backendUrls[0], "NEXT_PUBLIC_VKG_BACKEND_URL is missing."));
  }

  throw new Error("VKG trained model backend is not connected. Add NEXT_PUBLIC_VKG_BACKEND_URL, NEXT_PUBLIC_CORNEAL_BACKEND_URL, or split corneal backend URLs in Vercel before running VKG analysis.");
}

function uniqueUrls(urls: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      urls
        .map((url) => url?.trim().replace(/\/$/, ""))
        .filter((url): url is string => Boolean(url))
    )
  );
}

export async function predictRetina(file: File, options: RetinaPredictionOptions = {}): Promise<BackendPrediction> {
  const services = options.services ?? { dr: true, glaucoma: true, hr: true };
  if (!services.dr && !services.glaucoma && !services.hr) {
    throw new Error("Select at least one Retina screening model to run.");
  }
  const combinedRetinaUrl = process.env.NEXT_PUBLIC_RETINA_BACKEND_URL?.replace(/\/$/, "");
  const retinaDrUrl = (process.env.NEXT_PUBLIC_RETINA_DR_BACKEND_URL || combinedRetinaUrl)?.replace(/\/$/, "");
  const retinaDrGradcamEndpoint = "/api/retina/dr-gradcam";
  const retinaGlaucomaUrl = (process.env.NEXT_PUBLIC_RETINA_GLAUCOMA_BACKEND_URL || combinedRetinaUrl)?.replace(/\/$/, "");
  const retinaHrUrl = (process.env.NEXT_PUBLIC_RETINA_HR_BACKEND_URL || combinedRetinaUrl)?.replace(/\/$/, "");
  if (services.dr && !retinaDrUrl) {
    throw new Error("Retina DR backend URL is missing. Add NEXT_PUBLIC_RETINA_DR_BACKEND_URL or NEXT_PUBLIC_RETINA_BACKEND_URL.");
  }

  const dr = services.dr
    ? await postImageEndpoint(file, `${retinaDrUrl}/predict`, "Retina diabetic-retinopathy endpoint is missing.", "image").catch((error) => {
        throw new Error(`Retina DR endpoint failed: ${error instanceof Error ? error.message : "unknown error"}`);
      })
    : undefined;
  const [drGradcamResult, glaucomaResult, hypertensiveRetinopathyResult] = await Promise.allSettled([
    services.dr
      ? postImageEndpoint(file, retinaDrGradcamEndpoint, "Retina DR Grad-CAM endpoint is missing.", "image")
      : Promise.reject(new Error("DR not selected.")),
    services.glaucoma && retinaGlaucomaUrl
      ? postImageEndpoint(file, `${retinaGlaucomaUrl}/predict-glaucoma`, "Retina glaucoma endpoint is missing.", "image")
      : Promise.reject(new Error(services.glaucoma ? "NEXT_PUBLIC_RETINA_GLAUCOMA_BACKEND_URL is missing." : "Glaucoma not selected.")),
    services.hr && retinaHrUrl
      ? postImageEndpoint(file, `${retinaHrUrl}/predict-hr`, "Retina hypertensive-retinopathy endpoint is missing.", "image")
      : Promise.reject(new Error(services.hr ? "NEXT_PUBLIC_RETINA_HR_BACKEND_URL is missing." : "Hypertensive retinopathy not selected.")),
  ]);
  const optionalWarnings = [
    services.dr && drGradcamResult.status === "rejected" ? `DR Grad-CAM endpoint unavailable: ${drGradcamResult.reason instanceof Error ? drGradcamResult.reason.message : "unknown error"}` : "",
    services.glaucoma && glaucomaResult.status === "rejected" ? `Glaucoma endpoint unavailable: ${glaucomaResult.reason instanceof Error ? glaucomaResult.reason.message : "unknown error"}` : "",
    services.hr && hypertensiveRetinopathyResult.status === "rejected" ? `Hypertensive-retinopathy endpoint unavailable: ${hypertensiveRetinopathyResult.reason instanceof Error ? hypertensiveRetinopathyResult.reason.message : "unknown error"}` : "",
    ...(options.imageQualityWarnings ?? []),
  ].filter(Boolean);
  const glaucoma = services.glaucoma && glaucomaResult.status === "fulfilled" ? glaucomaResult.value as RetinaGlaucomaPrediction : undefined;
  const hypertensiveRetinopathy = services.hr && hypertensiveRetinopathyResult.status === "fulfilled" ? hypertensiveRetinopathyResult.value as RetinaHrPrediction : undefined;
  const gradcamPayload = drGradcamResult.status === "fulfilled"
    ? drGradcamResult.value as { heatmap?: string | null; heatmap_base64?: string | null; overlay?: string | null; gradcam_overlay_base64?: string | null }
    : undefined;
  const gradcamImage = gradcamPayload?.heatmap ?? gradcamPayload?.gradcam_overlay_base64 ?? gradcamPayload?.heatmap_base64 ?? gradcamPayload?.overlay;
  const drWithHeatmap = dr && drGradcamResult.status === "fulfilled"
    ? {
        ...dr,
        heatmap: (dr as { heatmap?: string | null }).heatmap ?? gradcamImage,
        gradcam_overlay_base64: dr.gradcam_overlay_base64 ?? gradcamImage
      }
    : dr;

  return normalizeRetinaPrediction(drWithHeatmap, glaucoma, hypertensiveRetinopathy, optionalWarnings, services);
}

type RetinaGlaucomaPrediction = {
  cdr?: number;
  confidence?: number;
  predicted_class?: string;
  risk_level?: string;
  risk_label?: string;
  risk_detail?: string;
  referral_recommendation?: string;
  disc_pixels?: number;
  cup_pixels?: number;
  metrics?: {
    disc_area?: number;
    cup_area?: number;
    disc_pixels?: number;
    cup_pixels?: number;
    output_dims?: number[];
  };
};

type RetinaHrPrediction = {
  hr_detected?: boolean;
  probability?: number;
  risk_level?: string;
  recommendation?: string;
  note?: string;
};

function normalizeRetinaPrediction(prediction: (BackendPrediction & {
  predicted_class?: number;
  severity_label?: string;
  scores?: Record<string, number> | number[];
  referral?: string;
  heatmap?: string | null;
  low_confidence?: boolean;
  confidence_warning?: string;
}) | undefined, glaucoma?: RetinaGlaucomaPrediction, hypertensiveRetinopathy?: RetinaHrPrediction, optionalWarnings: string[] = [], services: RetinaServiceSelection = { dr: true, glaucoma: true, hr: true }): BackendPrediction {
  const labels = ["NO_DR", "MILD_DR", "MODERATE_DR", "SEVERE_DR", "PROLIFERATIVE_DR"] as const;
  const scoreValues = prediction
    ? Array.isArray(prediction.scores)
      ? prediction.scores
      : labels.map((_, index) => Number((prediction.scores as Record<string, number> | undefined)?.[String(index)] ?? 0))
    : [0, 0, 0, 0, 0];
  const predictedClass = prediction ? labels[prediction.predicted_class ?? 0] ?? "NO_DR" : "NO_DR";
  const confidence = prediction ? Number(prediction.confidence ?? scoreValues[prediction.predicted_class ?? 0] ?? 0) : 0;
  const glaucomaRisk = glaucoma?.risk_level ?? glaucoma?.risk_label ?? (glaucoma?.predicted_class ? glaucoma.predicted_class : undefined);
  const glaucomaDetail = glaucoma?.risk_detail ?? glaucoma?.referral_recommendation ?? "";
  const glaucomaDiscPixels = glaucoma?.disc_pixels ?? glaucoma?.metrics?.disc_pixels ?? glaucoma?.metrics?.disc_area;
  const glaucomaCupPixels = glaucoma?.cup_pixels ?? glaucoma?.metrics?.cup_pixels ?? glaucoma?.metrics?.cup_area;
  const glaucomaSummary = glaucoma
    ? `Glaucoma: ${glaucomaRisk ?? "Unknown"}${typeof glaucoma.cdr === "number" ? `, CDR ${Number(glaucoma.cdr).toFixed(3)}` : ""}`
    : "Glaucoma: not run";
  const hrSummary = hypertensiveRetinopathy
    ? `Hypertensive retinopathy: ${hypertensiveRetinopathy.risk_level ?? (hypertensiveRetinopathy.hr_detected ? "Detected" : "Not detected")}${typeof hypertensiveRetinopathy.probability === "number" ? `, probability ${Math.round(hypertensiveRetinopathy.probability * 100)}%` : ""}`
    : "Hypertensive retinopathy: not run";
  const drSummary = services.dr ? `Diabetic retinopathy: ${prediction?.severity_label ?? predictedClass}` : "Diabetic retinopathy: not run";
  const warnings = [
    ...(prediction?.validation_warnings ?? []),
    services.dr && confidence > 0 && confidence < 0.7 ? "Low-confidence DR classification. Treat the top class as provisional and review the probability spread." : "",
    prediction?.low_confidence ? prediction.confidence_warning ?? "Low-confidence model output." : "",
    ...optionalWarnings
  ].filter(Boolean);
  const retinaDetails = {
    selected: services,
    dr: services.dr ? {
      class: predictedClass,
      confidence,
      low_confidence: confidence < 0.7 || Boolean(prediction?.low_confidence),
      referral: prediction?.referral ?? "",
      probabilities: {
        NO_DR: scoreValues[0] ?? 0,
        MILD_DR: scoreValues[1] ?? 0,
        MODERATE_DR: scoreValues[2] ?? 0,
        SEVERE_DR: scoreValues[3] ?? 0,
        PROLIFERATIVE_DR: scoreValues[4] ?? 0,
      },
    } : null,
    glaucoma: glaucoma ? {
      risk: glaucomaRisk ?? "",
      cdr: glaucoma.cdr ?? "",
      confidence: glaucoma.confidence ?? "",
      disc_pixels: glaucomaDiscPixels ?? "",
      cup_pixels: glaucomaCupPixels ?? "",
      detail: glaucomaDetail,
    } : null,
    hypertensive_retinopathy: hypertensiveRetinopathy ? {
      detected: hypertensiveRetinopathy.hr_detected ?? "",
      risk: hypertensiveRetinopathy.risk_level ?? "",
      probability: hypertensiveRetinopathy.probability ?? "",
      recommendation: hypertensiveRetinopathy.recommendation ?? "",
      threshold: 0.2,
    } : null,
    warnings,
  };

  return {
    ...(prediction ?? {}),
    prediction: predictedClass,
    confidence,
    probabilities: {
      NO_DR: scoreValues[0] ?? 0,
      MILD_DR: scoreValues[1] ?? 0,
      MODERATE_DR: scoreValues[2] ?? 0,
      SEVERE_DR: scoreValues[3] ?? 0,
      PROLIFERATIVE_DR: scoreValues[4] ?? 0,
    },
    is_valid_oct: true,
    quality_metrics: {
      ...(prediction?.quality_metrics ?? {}),
      glaucoma_cdr: glaucoma?.cdr ?? "",
      glaucoma_risk: glaucomaRisk ?? "",
      glaucoma_detail: glaucomaDetail,
      glaucoma_disc_pixels: glaucomaDiscPixels ?? "",
      glaucoma_cup_pixels: glaucomaCupPixels ?? "",
      hypertensive_retinopathy_detected: hypertensiveRetinopathy?.hr_detected ?? "",
      hypertensive_retinopathy_probability: hypertensiveRetinopathy?.probability ?? "",
      hypertensive_retinopathy_recommendation: hypertensiveRetinopathy?.recommendation ?? "",
    },
    model_name: "Retina Combined Screening Model",
    model_version: [`retina-details:${JSON.stringify(retinaDetails)}`, drSummary, glaucomaSummary, hrSummary].join(" | "),
    validation_warnings: warnings,
    gradcam_overlay_base64: prediction?.heatmap ?? prediction?.gradcam_overlay_base64,
    disclaimer:
      prediction?.disclaimer ||
      [drSummary, prediction?.referral, glaucomaSummary, glaucomaDetail, hrSummary, hypertensiveRetinopathy?.recommendation, prediction?.confidence_warning, ...optionalWarnings]
        .filter(Boolean)
        .join(" | ") ||
      "Fundus AI screening output. Requires clinician review.",
  };
}

function normalizeVkgPrediction(prediction: BackendPrediction): BackendPrediction {
  const rawProbabilities = prediction.probabilities as Record<string, number>;
  const keratoconus = rawProbabilities.keratoconus ?? rawProbabilities.KCN ?? rawProbabilities.KERATOCONUS_RISK ?? 0;
  const normal = rawProbabilities.non_keratoconus ?? rawProbabilities.NORMAL ?? rawProbabilities.NO_KERATOCONUS_RISK ?? 0;
  const rawPrediction = prediction.prediction as string;
  const isValidVkg = prediction.is_valid_corneal ?? prediction.is_valid_oct ?? true;
  const mappedPrediction = rawPrediction === "KERATOCONUS_RISK"
    ? "KCN"
    : rawPrediction === "NO_KERATOCONUS_RISK"
      ? "NORMAL"
      : rawPrediction === "KCN" || rawPrediction === "NORMAL"
        ? rawPrediction
        : keratoconus >= normal
          ? "KCN"
          : "NORMAL";

  if (mappedPrediction === "NORMAL" || mappedPrediction === "KCN") {
    return {
      ...prediction,
      prediction: mappedPrediction,
      probabilities: {
        NORMAL: normal,
        KCN: keratoconus,
      },
      is_valid_oct: isValidVkg,
      model_name: prediction.model_name || "VKG Keratoconus Screening Model",
      disclaimer: prediction.disclaimer || "VKG/topography AI screening output. Requires clinician review.",
    };
  }

  return {
    ...prediction,
    is_valid_oct: isValidVkg,
  };
}

function normalizeVkgEnsemblePrediction(predictions: BackendPrediction[]): BackendPrediction {
  if (predictions.length === 0) {
    throw new Error("No VKG backend predictions returned.");
  }

  const normalized = predictions.map(normalizeVkgPrediction);
  const validPredictions = normalized.filter((prediction) => {
    const probabilities = prediction.probabilities as Record<string, number>;
    return (prediction.is_valid_oct ?? true) && (probabilities.NORMAL != null || probabilities.KCN != null);
  });
  if (validPredictions.length === 0) {
    return normalized[0];
  }

  const probabilitySum = validPredictions.reduce(
    (sum, prediction) => {
      const probabilities = prediction.probabilities as Record<string, number>;
      return {
        NORMAL: sum.NORMAL + Number(probabilities.NORMAL ?? 0),
        KCN: sum.KCN + Number(probabilities.KCN ?? 0),
      };
    },
    { NORMAL: 0, KCN: 0 }
  );
  const probabilities = {
    NORMAL: Number((probabilitySum.NORMAL / validPredictions.length).toFixed(4)),
    KCN: Number((probabilitySum.KCN / validPredictions.length).toFixed(4)),
  };
  const prediction = probabilities.KCN >= probabilities.NORMAL ? "KCN" : "NORMAL";
  const confidence = prediction === "KCN" ? probabilities.KCN : probabilities.NORMAL;
  const modelNames = normalized.map((item) => item.model_name).filter(Boolean);
  const modelVersions = normalized.map((item) => item.model_version).filter(Boolean);
  const modelsUsed = normalized.flatMap((item) => Array.isArray(item.models_used) ? item.models_used : []);
  const first = normalized[0];

  return {
    ...first,
    prediction,
    confidence,
    probabilities,
    models_used: Array.from(new Set(modelsUsed)),
    is_valid_oct: normalized.every((item) => item.is_valid_oct ?? true),
    model_name: modelNames.length ? `Split ${Array.from(new Set(modelNames)).join(" + ")}` : "Split VKG Keratoconus Screening Model",
    model_version: modelVersions.length ? Array.from(new Set(modelVersions)).join(" | ") : first.model_version,
    disclaimer: first.disclaimer || "VKG/topography split-model ensemble output. Requires clinician review.",
    request_time_ms: Math.max(...normalized.map((item) => Number(item.request_time_ms ?? 0))),
  };
}
