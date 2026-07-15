import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const clinicalRoles = ["hospital_admin", "admin", "doctor", "assistant"] as const;

function jsonError(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function requiredEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey };
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value.trim());
}

export async function POST(request: NextRequest) {
  const env = requiredEnv();
  if (!env) return jsonError("Signup approval is not configured.", 500);

  const body = await request.json().catch(() => ({}));
  const userId = String(body.user_id ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = String(body.full_name ?? "").trim();
  const role = String(body.role ?? "").trim();
  const doctorId = String(body.doctor_id ?? "").trim() || null;
  const clinicId = String(body.clinic_id ?? "").trim();
  const clinicName = String(body.clinic_name ?? "").trim();

  if (!userId) return jsonError("Signup user ID is required.");
  if (!isEmail(email)) return jsonError("A valid email is required.");
  if (!fullName) return jsonError("Full name is required.");
  if (!clinicalRoles.includes(role as typeof clinicalRoles[number])) return jsonError("Unsupported requested role.");
  if (!clinicId || !clinicName) return jsonError("Hospital selection is required.");

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(userId);
  if (authError || !authUser.user) return jsonError("Could not verify signup user.", 404);
  if (authUser.user.email?.toLowerCase() !== email) return jsonError("Signup email did not match the auth user.", 403);

  const { data: hospital, error: hospitalError } = await admin
    .from("clinics")
    .select("id,name,is_active,allow_self_signup,subscription_status")
    .eq("id", clinicId)
    .maybeSingle();
  if (hospitalError) return jsonError("Could not verify selected hospital.", 500);
  if (!hospital || !hospital.is_active || hospital.allow_self_signup === false || hospital.subscription_status === "suspended") {
    return jsonError("This hospital is not accepting account requests.");
  }

  const { data: existingProfile, error: existingError } = await admin
    .from("profiles")
    .select("id")
    .or(`id.eq.${userId},email.eq.${email}`)
    .maybeSingle();
  if (existingError) return jsonError("Could not check existing profile.", 500);
  if (existingProfile) return NextResponse.json({ ok: true, alreadyExists: true });

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .insert({
      id: userId,
      full_name: fullName,
      email,
      role,
      doctor_id: doctorId,
      specialization: null,
      clinic_id: clinicId,
      clinic_name: clinicName,
      is_active: false,
      business_permissions: null
    })
    .select("*")
    .single();

  if (profileError) {
    console.error("Signup profile insert failed.", profileError);
    return jsonError("Could not create pending approval request.", 500);
  }

  await admin.from("audit_logs").insert({
    user_id: userId,
    action: "User signup",
    record_type: "profile",
    record_id: userId,
    details: { message: `${email} requested ${role} access for ${clinicName}` }
  });

  return NextResponse.json({ ok: true, profile });
}
