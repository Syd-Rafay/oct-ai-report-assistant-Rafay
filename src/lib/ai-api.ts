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
      detail = body.detail ?? detail;
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

async function postImageEndpoint(file: File, endpointUrl: string | undefined, missingMessage: string): Promise<BackendPrediction> {
  if (!endpointUrl) {
    throw new Error(missingMessage);
  }

  const formData = new FormData();
  formData.append("file", file);
  const startedAt = performance.now();

  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: "POST",
      body: formData
    });
  } catch {
    throw new Error("Could not reach the AI backend. Check your internet connection, Render backend status, or CORS settings.");
  }

  if (!response.ok) {
    let detail = "AI prediction failed.";
    try {
      const body = await response.json();
      detail = body.detail ?? detail;
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
  return postImagePrediction(
    file,
    process.env.NEXT_PUBLIC_CORNEAL_BACKEND_URL,
    "NEXT_PUBLIC_CORNEAL_BACKEND_URL is missing. Add the Corneal Render service URL."
  );
}

export async function predictVKG(file: File): Promise<BackendPrediction> {
  const vkgBackendUrl = process.env.NEXT_PUBLIC_VKG_BACKEND_URL ?? process.env.NEXT_PUBLIC_CORNEAL_BACKEND_URL;
  if (vkgBackendUrl) {
    return normalizeVkgPrediction(await postImagePrediction(file, vkgBackendUrl, "NEXT_PUBLIC_VKG_BACKEND_URL is missing."));
  }

  throw new Error("VKG trained model backend is not connected. Add NEXT_PUBLIC_VKG_BACKEND_URL or NEXT_PUBLIC_CORNEAL_BACKEND_URL in Vercel before running VKG analysis.");
}

export async function predictRetina(file: File): Promise<BackendPrediction> {
  return normalizeRetinaPrediction(
    await postImagePrediction(
      file,
      process.env.NEXT_PUBLIC_RETINA_BACKEND_URL,
      "NEXT_PUBLIC_RETINA_BACKEND_URL is missing. Add the Retina Render service URL.",
      "image"
    )
  );
}

function normalizeRetinaPrediction(prediction: BackendPrediction & {
  predicted_class?: number;
  severity_label?: string;
  scores?: Record<string, number> | number[];
  referral?: string;
  heatmap?: string | null;
  low_confidence?: boolean;
  confidence_warning?: string;
}): BackendPrediction {
  const labels = ["NO_DR", "MILD_DR", "MODERATE_DR", "SEVERE_DR", "PROLIFERATIVE_DR"] as const;
  const scoreValues = Array.isArray(prediction.scores)
    ? prediction.scores
    : labels.map((_, index) => Number((prediction.scores as Record<string, number> | undefined)?.[String(index)] ?? 0));
  const predictedClass = labels[prediction.predicted_class ?? 0] ?? "NO_DR";

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
    model_name: prediction.model_name || "Retina Diabetic Retinopathy Screening Model",
    model_version: prediction.model_version || "Group 3 ONNX",
    gradcam_overlay_base64: prediction.heatmap ?? prediction.gradcam_overlay_base64,
    disclaimer:
      prediction.disclaimer ||
      [prediction.severity_label, prediction.referral, prediction.confidence_warning]
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
