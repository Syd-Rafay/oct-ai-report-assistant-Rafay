import type { BackendPrediction } from "./types";

export async function predictOCT(file: File): Promise<BackendPrediction> {
  const backendUrl = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

  if (!backendUrl) {
    throw new Error("NEXT_PUBLIC_AI_BACKEND_URL is missing. Add it to .env.local.");
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
