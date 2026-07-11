import type { BackendPrediction } from "./types";

async function postImagePrediction(file: File, backendUrl: string | undefined, missingMessage: string): Promise<BackendPrediction> {
  if (!backendUrl) {
    throw new Error(missingMessage);
  }

  const formData = new FormData();
  formData.append("file", file);
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

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const size = 96;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare VKG image for analysis.");
  context.drawImage(bitmap, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  let redDominance = 0;
  let greenDominance = 0;
  let brightPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    redDominance += Math.max(0, red - green) / 255;
    greenDominance += Math.max(0, green - red) / 255;
    if ((red + green + blue) / 3 > 175) brightPixels += 1;
  }
  const total = pixels.length / 4;
  const redScore = redDominance / total;
  const greenScore = greenDominance / total;
  const brightScore = brightPixels / total;
  const kcnScore = Math.min(0.88, 0.42 + redScore * 1.9);
  const normalScore = Math.min(0.86, 0.38 + greenScore * 1.4 + brightScore * 0.15);
  const suspectScore = Math.max(0.12, 1 - Math.max(kcnScore, normalScore));
  const prediction = kcnScore > normalScore + 0.08 ? "KCN" : normalScore > kcnScore + 0.08 ? "NORMAL" : "SUSPECT";
  const probabilities = {
    NORMAL: prediction === "NORMAL" ? normalScore : Math.max(0.08, normalScore * 0.75),
    KCN: prediction === "KCN" ? kcnScore : Math.max(0.08, kcnScore * 0.75),
    SUSPECT: prediction === "SUSPECT" ? Math.max(suspectScore, 0.54) : suspectScore
  };
  const sum = probabilities.NORMAL + probabilities.KCN + probabilities.SUSPECT;
  return {
    prediction,
    confidence: probabilities[prediction] / sum,
    probabilities: {
      NORMAL: probabilities.NORMAL / sum,
      KCN: probabilities.KCN / sum,
      SUSPECT: probabilities.SUSPECT / sum
    },
    model_name: "VKG Keratoconus Demo Model",
    model_version: "demo-v1.0",
    is_valid_oct: true,
    disclaimer: "VKG/topography AI screening output. Demo fallback is active until the trained VKG model API is connected."
  };
}

function normalizeVkgPrediction(prediction: BackendPrediction): BackendPrediction {
  const rawProbabilities = prediction.probabilities as Record<string, number>;
  const keratoconus = rawProbabilities.keratoconus ?? rawProbabilities.KCN ?? rawProbabilities.KERATOCONUS_RISK ?? 0;
  const normal = rawProbabilities.non_keratoconus ?? rawProbabilities.NORMAL ?? rawProbabilities.NO_KERATOCONUS_RISK ?? 0;
  const suspect = rawProbabilities.SUSPECT ?? Math.max(0, 1 - Math.max(keratoconus, normal));
  const rawPrediction = prediction.prediction as string;
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
      model_name: prediction.model_name || "VKG Keratoconus Screening Model",
      disclaimer: prediction.disclaimer || "VKG/topography AI screening output. Requires clinician review.",
    };
  }

  return prediction;
}
