import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { buildSignedRequestHeaders } from "@/lib/request-signing";

export type GatewayEnv = {
  backendUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  sharedSecret: string;
};

export type GatewayBaseEnv = {
  supabaseUrl: string;
  serviceRoleKey: string;
  sharedSecret: string;
};

export type GatewayAuthResult =
  | {
      userId: string;
    }
  | NextResponse;

export const MAX_GATEWAY_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
export const GATEWAY_ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function requiredGatewayEnv(backendUrlEnvNames: string[]) {
  const backendUrl = backendUrlEnvNames.map((name) => process.env[name]?.replace(/\/$/, "")).find(Boolean);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedSecret = process.env.AI_GATEWAY_SHARED_SECRET;
  if (!backendUrl || !supabaseUrl || !serviceRoleKey || !sharedSecret) return null;
  return { backendUrl, supabaseUrl, serviceRoleKey, sharedSecret } satisfies GatewayEnv;
}

export function requiredGatewayBaseEnv(): GatewayBaseEnv | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedSecret = process.env.AI_GATEWAY_SHARED_SECRET;
  if (!supabaseUrl || !serviceRoleKey || !sharedSecret) return null;
  return { supabaseUrl, serviceRoleKey, sharedSecret };
}

export function configuredGatewayUrls(backendUrlEnvNames: string[]) {
  return Array.from(
    new Set(
      backendUrlEnvNames
        .map((name) => process.env[name]?.replace(/\/$/, ""))
        .filter((value): value is string => Boolean(value))
    )
  );
}

export async function requireGatewayModuleAccess(
  request: NextRequest,
  env: Pick<GatewayEnv, "supabaseUrl" | "serviceRoleKey">,
  moduleId: string
): Promise<GatewayAuthResult> {
  const authResult = await requireAuth(request);
  if (authResult instanceof Response) return authResult;

  if (authResult.profile.role === "afio_admin") {
    return { userId: authResult.user.id };
  }

  const clinicId = String(authResult.profile.clinic_id ?? "");
  if (!clinicId) {
    return jsonError("You are not authorized to use this module.", 403);
  }

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data, error } = await admin
    .from("clinic_modules")
    .select("module_id,is_enabled")
    .eq("clinic_id", clinicId)
    .eq("module_id", moduleId)
    .maybeSingle();

  if (error) return jsonError(`Could not verify ${moduleId} module access.`, 500);
  if (!data || data.is_enabled === false) return jsonError("You are not authorized to use this module.", 403);

  return { userId: authResult.user.id };
}

export function validateGatewayUpload(file: File) {
  if (!GATEWAY_ALLOWED_CONTENT_TYPES.has(file.type)) {
    return jsonError("Only JPG, JPEG, and PNG images are supported.", 400);
  }
  if (file.size <= 0 || file.size > MAX_GATEWAY_UPLOAD_SIZE_BYTES) {
    return jsonError("Uploaded image is too large.", 413);
  }
  return null;
}

export async function forwardSignedUpload(input: {
  backendUrl: string;
  backendPath: string;
  file: File;
  fieldName?: string;
  sharedSecret: string;
  extraHeaders?: Record<string, string>;
}) {
  const payload = Buffer.from(await input.file.arrayBuffer()).toString("base64");
  const headers = buildSignedRequestHeaders(payload, input.sharedSecret, {
    signatureHeader: "X-AFIO-Signature",
    timestampHeader: "X-AFIO-Timestamp"
  });

  const forward = new FormData();
  forward.append(input.fieldName ?? "file", input.file, input.file.name || "image.jpg");

  const response = await fetch(`${input.backendUrl}${input.backendPath}`, {
    method: "POST",
    headers: {
      ...headers,
      ...(input.extraHeaders ?? {})
    },
    body: forward
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}