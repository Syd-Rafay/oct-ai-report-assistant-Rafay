import { NextRequest, NextResponse } from "next/server";
import { normalizeVkgEnsemblePrediction } from "@/lib/ai-api";
import {
  configuredGatewayUrls,
  forwardSignedUpload,
  jsonError,
  requiredGatewayBaseEnv,
  requireGatewayModuleAccess,
  validateGatewayUpload
} from "@/lib/ai-gateway";
import { createInMemoryRateLimiter, rateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

const limiter = createInMemoryRateLimiter(10 * 60 * 1000, 20);
const CORNEAL_BACKEND_ENV_NAMES = [
  "VKG_BACKEND_URL",
  "CORNEAL_BACKEND_URL",
  "CORNEAL_RESNET_BACKEND_URL",
  "CORNEAL_DENSENET_BACKEND_URL",
  "CORNEAL_EFFICIENTNET_BACKEND_URL"
];

export async function POST(request: NextRequest) {
  const env = requiredGatewayBaseEnv();
  if (!env) return jsonError("Corneal gateway is not configured.", 500);

  const accessResult = await requireGatewayModuleAccess(request, env, "corneal");
  if (accessResult instanceof Response) return accessResult;

  if (limiter.isRateLimited(rateLimitKey(request, accessResult.userId))) {
    return jsonError("Too many attempts. Please wait before trying again.", 429);
  }

  const incoming = await request.formData().catch(() => null);
  if (!incoming) return jsonError("No image file uploaded.", 400);

  const uploaded = incoming.get("file") ?? incoming.get("image");
  if (!(uploaded instanceof File)) {
    return jsonError("No image file uploaded.", 400);
  }

  const validationError = validateGatewayUpload(uploaded);
  if (validationError) return validationError;

  const backendUrls = configuredGatewayUrls(CORNEAL_BACKEND_ENV_NAMES);
  if (!backendUrls.length) return jsonError("Corneal gateway is not configured.", 500);

  try {
    const predictions = await Promise.all(
      backendUrls.map(async (backendUrl) => {
        const response = await forwardSignedUpload({
          backendUrl,
          backendPath: "/predict",
          file: uploaded,
          fieldName: "file",
          sharedSecret: env.sharedSecret
        });

        if (!response.ok) {
          let detail = "AI prediction failed.";
          try {
            const body = await response.json();
            detail = body.detail ?? body.error ?? detail;
          } catch {
            // Keep the generic message if the backend did not return JSON.
          }
          const backendError = new Error(detail);
          (backendError as Error & { status?: number }).status = response.status;
          throw backendError;
        }

        return response.json();
      })
    );

    return NextResponse.json(normalizeVkgEnsemblePrediction(predictions));
  } catch (error) {
    if (error instanceof Error && typeof (error as Error & { status?: number }).status === "number") {
      return jsonError(error.message, (error as Error & { status?: number }).status ?? 502);
    }
    return jsonError("Could not reach Corneal backend.", 502);
  }
}
