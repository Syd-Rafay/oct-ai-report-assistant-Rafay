import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/require-auth";
import { createInMemoryRateLimiter, rateLimitKey } from "@/lib/rate-limit";
import { buildSignedRequestHeaders } from "@/lib/request-signing";

export const runtime = "nodejs";

const limiter = createInMemoryRateLimiter(10 * 60 * 1000, 20);
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function requiredEnv() {
  const backendUrl = process.env.OCT_AI_BACKEND_URL?.replace(/\/$/, "");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedSecret = process.env.AI_GATEWAY_SHARED_SECRET;
  if (!backendUrl || !supabaseUrl || !serviceRoleKey || !sharedSecret) return null;
  return { backendUrl, supabaseUrl, serviceRoleKey, sharedSecret };
}

function requestIsGradcam(request: NextRequest, incoming: FormData) {
  const headerMode = request.headers.get("x-afio-mode")?.trim().toLowerCase();
  const headerGradcam = request.headers.get("x-afio-gradcam")?.trim().toLowerCase();
  const formMode = incoming.get("mode");
  const formGradcam = incoming.get("gradcam");

  return (
    headerMode === "gradcam" ||
    headerGradcam === "1" ||
    headerGradcam === "true" ||
    formMode === "gradcam" ||
    formMode === "grad-cam" ||
    formMode === "grad_cam" ||
    formGradcam === "1" ||
    formGradcam === "true"
  );
}

export async function POST(request: NextRequest) {
  const env = requiredEnv();
  if (!env) return jsonError("OCT gateway is not configured.", 500);

  const authResult = await requireAuth(request);
  if (authResult instanceof Response) return authResult;

  if (authResult.profile.role !== "afio_admin") {
    if (!authResult.profile.clinic_id) {
      return jsonError("You are not authorized to use the OCT module.", 403);
    }

    const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: entitlement, error: entitlementError } = await admin
      .from("clinic_modules")
      .select("module_id,is_enabled")
      .eq("clinic_id", authResult.profile.clinic_id)
      .eq("module_id", "oct")
      .maybeSingle();

    if (entitlementError) {
      return jsonError("Could not verify OCT module access.", 500);
    }
    if (!entitlement || entitlement.is_enabled === false) {
      return jsonError("You are not authorized to use the OCT module.", 403);
    }
  }

  if (limiter.isRateLimited(rateLimitKey(request, authResult.user.id))) {
    return jsonError("Too many attempts. Please wait before trying again.", 429);
  }

  const incoming = await request.formData().catch(() => null);
  if (!incoming) return jsonError("No image file uploaded.", 400);

  const uploaded = incoming.get("image") ?? incoming.get("file");
  if (!(uploaded instanceof File)) {
    return jsonError("No image file uploaded.", 400);
  }
  if (![
    "image/jpeg",
    "image/png"
  ].includes(uploaded.type)) {
    return jsonError("Only JPG, JPEG, and PNG OCT images are supported.", 400);
  }
  if (uploaded.size <= 0 || uploaded.size > MAX_UPLOAD_SIZE_BYTES) {
    return jsonError("Uploaded image is too large.", 413);
  }

  const isGradcam = requestIsGradcam(request, incoming);

  const signedPayload = Buffer.from(await uploaded.arrayBuffer()).toString("base64");
  const signedHeaders = buildSignedRequestHeaders(signedPayload, env.sharedSecret, {
    signatureHeader: "X-AFIO-Signature",
    timestampHeader: "X-AFIO-Timestamp"
  });

  const forward = new FormData();
  forward.append("file", uploaded, uploaded.name || "oct-scan.jpg");

  let response: Response;
  try {
    response = await fetch(`${env.backendUrl}/${isGradcam ? "gradcam" : "predict"}`, {
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