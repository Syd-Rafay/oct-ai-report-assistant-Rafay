import type { BackendPrediction } from "./types";

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

export async function predictOCT(file: File): Promise<BackendPrediction> {
  return postImagePrediction(
    file,
    process.env.NEXT_PUBLIC_AI_BACKEND_URL,
    "NEXT_PUBLIC_AI_BACKEND_URL is missing. Add it to .env.local."
  );
}

export async function predictOCTWithGradcam(file: File): Promise<BackendPrediction> {
  try {
    return await postImageEndpoint(
      file,
      process.env.NEXT_PUBLIC_AI_BACKEND_URL ? `${process.env.NEXT_PUBLIC_AI_BACKEND_URL.replace(/\/$/, "")}/gradcam` : undefined,
      "NEXT_PUBLIC_AI_BACKEND_URL is missing. Add it to .env.local."
    );
  } catch {
    return predictOCT(file);
  }
}

export async function predictCorneal(file: File): Promise<BackendPrediction> {
  return predictVKG(file);
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

export async function predictRetina(file: File): Promise<BackendPrediction> {
  const retinaBackendUrl = process.env.NEXT_PUBLIC_RETINA_BACKEND_URL?.replace(/\/$/, "");
  if (!retinaBackendUrl) {
    throw new Error("NEXT_PUBLIC_RETINA_BACKEND_URL is missing. Add the Retina Render service URL.");
  }

  const dr = await postImageEndpoint(file, `${retinaBackendUrl}/predict`, "Retina diabetic-retinopathy endpoint is missing.", "image").catch((error) => {
    throw new Error(`Retina DR endpoint failed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  const [glaucomaResult, hypertensiveRetinopathyResult] = await Promise.allSettled([
    postImageEndpoint(file, `${retinaBackendUrl}/predict-glaucoma`, "Retina glaucoma endpoint is missing.", "image"),
    postImageEndpoint(file, `${retinaBackendUrl}/predict-hr`, "Retina hypertensive-retinopathy endpoint is missing.", "image"),
  ]);
  const optionalWarnings = [
    glaucomaResult.status === "rejected" ? `Glaucoma endpoint unavailable: ${glaucomaResult.reason instanceof Error ? glaucomaResult.reason.message : "unknown error"}` : "",
    hypertensiveRetinopathyResult.status === "rejected" ? `Hypertensive-retinopathy endpoint unavailable: ${hypertensiveRetinopathyResult.reason instanceof Error ? hypertensiveRetinopathyResult.reason.message : "unknown error"}` : "",
  ].filter(Boolean);
  const glaucoma = glaucomaResult.status === "fulfilled" ? glaucomaResult.value as RetinaGlaucomaPrediction : undefined;
  const hypertensiveRetinopathy = hypertensiveRetinopathyResult.status === "fulfilled" ? hypertensiveRetinopathyResult.value as RetinaHrPrediction : undefined;

  return normalizeRetinaPrediction(dr, glaucoma, hypertensiveRetinopathy, optionalWarnings);
}

type RetinaGlaucomaPrediction = {
  cdr?: number;
  risk_level?: string;
  risk_detail?: string;
  disc_pixels?: number;
  cup_pixels?: number;
};

type RetinaHrPrediction = {
  hr_detected?: boolean;
  probability?: number;
  risk_level?: string;
  recommendation?: string;
  note?: string;
};

function normalizeRetinaPrediction(prediction: BackendPrediction & {
  predicted_class?: number;
  severity_label?: string;
  scores?: Record<string, number> | number[];
  referral?: string;
  heatmap?: string | null;
  low_confidence?: boolean;
  confidence_warning?: string;
}, glaucoma?: RetinaGlaucomaPrediction, hypertensiveRetinopathy?: RetinaHrPrediction, optionalWarnings: string[] = []): BackendPrediction {
  const labels = ["NO_DR", "MILD_DR", "MODERATE_DR", "SEVERE_DR", "PROLIFERATIVE_DR"] as const;
  const scoreValues = Array.isArray(prediction.scores)
    ? prediction.scores
    : labels.map((_, index) => Number((prediction.scores as Record<string, number> | undefined)?.[String(index)] ?? 0));
  const predictedClass = labels[prediction.predicted_class ?? 0] ?? "NO_DR";
  const glaucomaSummary = glaucoma
    ? `Glaucoma: ${glaucoma.risk_level ?? "Unknown"}${typeof glaucoma.cdr === "number" ? `, CDR ${glaucoma.cdr}` : ""}`
    : "Glaucoma: not run";
  const hrSummary = hypertensiveRetinopathy
    ? `Hypertensive retinopathy: ${hypertensiveRetinopathy.risk_level ?? (hypertensiveRetinopathy.hr_detected ? "Detected" : "Not detected")}${typeof hypertensiveRetinopathy.probability === "number" ? `, probability ${Math.round(hypertensiveRetinopathy.probability * 100)}%` : ""}`
    : "Hypertensive retinopathy: not run";
  const drSummary = `Diabetic retinopathy: ${prediction.severity_label ?? predictedClass}`;

  return {
    ...prediction,
    prediction: predictedClass,
    confidence: Number(prediction.confidence ?? scoreValues[prediction.predicted_class ?? 0] ?? 0),
    probabilities: {
      NO_DR: scoreValues[0] ?? 0,
      MILD_DR: scoreValues[1] ?? 0,
      MODERATE_DR: scoreValues[2] ?? 0,
      SEVERE_DR: scoreValues[3] ?? 0,
      PROLIFERATIVE_DR: scoreValues[4] ?? 0,
    },
    is_valid_oct: true,
    quality_metrics: {
      ...(prediction.quality_metrics ?? {}),
      glaucoma_cdr: glaucoma?.cdr ?? "",
      glaucoma_risk: glaucoma?.risk_level ?? "",
      glaucoma_detail: glaucoma?.risk_detail ?? "",
      hypertensive_retinopathy_detected: hypertensiveRetinopathy?.hr_detected ?? "",
      hypertensive_retinopathy_probability: hypertensiveRetinopathy?.probability ?? "",
      hypertensive_retinopathy_recommendation: hypertensiveRetinopathy?.recommendation ?? "",
    },
    model_name: "Retina Combined Screening Model",
    model_version: [drSummary, glaucomaSummary, hrSummary].join(" | "),
    validation_warnings: [...(prediction.validation_warnings ?? []), ...optionalWarnings],
    gradcam_overlay_base64: prediction.heatmap ?? prediction.gradcam_overlay_base64,
    disclaimer:
      prediction.disclaimer ||
      [drSummary, prediction.referral, glaucomaSummary, glaucoma?.risk_detail, hrSummary, hypertensiveRetinopathy?.recommendation, prediction.confidence_warning, ...optionalWarnings]
        .filter(Boolean)
        .join(" | ") ||
      "Fundus AI screening output. Requires clinician review.",
  };
}

function normalizeVkgPrediction(prediction: BackendPrediction): BackendPrediction {
  const rawProbabilities = prediction.probabilities as Record<string, number>;
  const keratoconus = rawProbabilities.keratoconus ?? rawProbabilities.KCN ?? rawProbabilities.KERATOCONUS_RISK ?? 0;
  const normal = rawProbabilities.non_keratoconus ?? rawProbabilities.NORMAL ?? rawProbabilities.NO_KERATOCONUS_RISK ?? 0;
  const suspect = rawProbabilities.SUSPECT ?? Math.max(0, 1 - Math.max(keratoconus, normal));
  const rawPrediction = prediction.prediction as string;
  const isValidVkg = prediction.is_valid_corneal ?? prediction.is_valid_oct ?? true;
  const mappedPrediction = rawPrediction === "KERATOCONUS_RISK"
    ? "KCN"
    : rawPrediction === "NO_KERATOCONUS_RISK"
      ? "NORMAL"
      : prediction.prediction;

  if (mappedPrediction === "NORMAL" || mappedPrediction === "KCN" || mappedPrediction === "SUSPECT") {
    return {
      ...prediction,
      prediction: mappedPrediction,
      probabilities: {
        NORMAL: normal,
        KCN: keratoconus,
        SUSPECT: suspect,
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
        SUSPECT: sum.SUSPECT + Number(probabilities.SUSPECT ?? 0),
      };
    },
    { NORMAL: 0, KCN: 0, SUSPECT: 0 }
  );
  const probabilities = {
    NORMAL: Number((probabilitySum.NORMAL / validPredictions.length).toFixed(4)),
    KCN: Number((probabilitySum.KCN / validPredictions.length).toFixed(4)),
    SUSPECT: Number((probabilitySum.SUSPECT / validPredictions.length).toFixed(4)),
  };
  const prediction = probabilities.KCN >= 0.5 ? "KCN" : probabilities.SUSPECT >= 0.4 ? "SUSPECT" : "NORMAL";
  const confidence = prediction === "KCN" ? probabilities.KCN : prediction === "SUSPECT" ? probabilities.SUSPECT : probabilities.NORMAL;
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
