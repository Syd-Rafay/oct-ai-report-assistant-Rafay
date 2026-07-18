import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { createInMemoryRateLimiter, rateLimitKey } from "@/lib/rate-limit";
import { buildSignedRequestHeaders } from "@/lib/request-signing";

export const runtime = "nodejs";

const limiter = createInMemoryRateLimiter(10 * 60 * 1000, 20);

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function requiredEnv() {
  const backendUrl = process.env.OCT_AI_BACKEND_URL?.replace(/\/$/, "");
  const sharedSecret = process.env.AI_GATEWAY_SHARED_SECRET;
  if (!backendUrl || !sharedSecret) return null;
  return { backendUrl, sharedSecret };
}

export async function POST(request: NextRequest) {
  const env = requiredEnv();
  if (!env) return jsonError("OCT gateway is not configured.", 500);

  const authResult = await requireAuth(request);
  if (authResult instanceof Response) return authResult;

  if (limiter.isRateLimited(rateLimitKey(request, authResult.user.id))) {
    return jsonError("Too many attempts. Please wait before trying again.", 429);
  }

  const incoming = await request.formData().catch(() => null);
  if (!incoming) return jsonError("No image file uploaded.", 400);

  const uploaded = incoming.get("image") ?? incoming.get("file");
  if (!(uploaded instanceof File)) {
    return jsonError("No image file uploaded.", 400);
  }

  const signedPayload = Buffer.from(await uploaded.arrayBuffer()).toString("base64");
  const signedHeaders = buildSignedRequestHeaders(signedPayload, env.sharedSecret, {
    signatureHeader: "X-AFIO-Signature",
    timestampHeader: "X-AFIO-Timestamp"
  });

  const forward = new FormData();
  forward.append("file", uploaded, uploaded.name || "oct-scan.jpg");

  let response: Response;
  try {
    response = await fetch(`${env.backendUrl}/predict`, {
      method: "POST",
      headers: signedHeaders,
      body: forward
    });
  } catch {
    return jsonError("Could not reach OCT backend.", 502);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}