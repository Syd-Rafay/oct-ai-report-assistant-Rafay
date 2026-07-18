import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

type AuthEnv = {
  supabaseUrl: string;
  serviceRoleKey: string;
};

export type AuthenticatedProfile = Record<string, unknown> & { id: string };

export type RequireAuthResult =
  | {
      user: User;
      profile: AuthenticatedProfile;
    }
  | NextResponse;

function jsonError(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function requiredEnv(): AuthEnv | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey };
}

function createAdminClient(env: AuthEnv) {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function requireAuth(request: NextRequest): Promise<RequireAuthResult> {
  const env = requiredEnv();
  if (!env) return jsonError("Authentication is not configured.", 500);

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonError("Missing admin session.", 401);

  const admin = createAdminClient(env);
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return jsonError("Invalid admin session.", 401);

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError) return jsonError("Could not verify admin access.", 500);
  if (!profile) return jsonError("Profile not found.", 404);

  return {
    user: authData.user,
    profile: profile as AuthenticatedProfile
  };
}