import { NextRequest } from "next/server";
import { forwardSignedUpload, jsonError, requiredGatewayEnv, requireGatewayModuleAccess, validateGatewayUpload } from "@/lib/ai-gateway";
import { createInMemoryRateLimiter, rateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

const limiter = createInMemoryRateLimiter(10 * 60 * 1000, 20);

export async function POST(request: NextRequest) {
  const env = requiredGatewayEnv(["RETINA_HR_BACKEND_URL", "RETINA_BACKEND_URL"]);
  if (!env) return jsonError("Retina hypertensive-retinopathy gateway is not configured.", 500);

  const accessResult = await requireGatewayModuleAccess(request, env, "retina");
  if (accessResult instanceof Response) return accessResult;

  if (limiter.isRateLimited(rateLimitKey(request, accessResult.userId))) {
    return jsonError("Too many attempts. Please wait before trying again.", 429);
  }

  const incoming = await request.formData().catch(() => null);
  if (!incoming) return jsonError("No image file uploaded.", 400);

  const uploaded = incoming.get("image") ?? incoming.get("file");
  if (!(uploaded instanceof File)) {
    return jsonError("No image file uploaded.", 400);
  }

  const validationError = validateGatewayUpload(uploaded);
  if (validationError) return validationError;

  try {
    return await forwardSignedUpload({
      backendUrl: env.backendUrl,
      backendPath: "/predict-hr",
      file: uploaded,
      fieldName: "image",
      sharedSecret: env.sharedSecret
    });
  } catch {
    return jsonError("Could not reach Retina hypertensive-retinopathy backend.", 502);
  }
}
