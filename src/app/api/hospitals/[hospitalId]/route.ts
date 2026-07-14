import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function jsonError(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

function requiredEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey };
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ hospitalId: string }> }
) {
  const env = requiredEnv();
  if (!env) {
    console.error("Hospital removal is missing server environment variables.");
    return jsonError("Server provisioning is not configured. Ask AFIO admin to check deployment settings.", 500);
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonError("Missing Business Admin session.", 401);

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return jsonError("Invalid Business Admin session.", 401);

  const { data: requester, error: requesterError } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (requesterError || requester?.role !== "afio_admin") {
    return jsonError("Only AFIO Business Admin can remove hospitals.", 403);
  }

  const params = await context.params;
  const hospitalId = params.hospitalId;
  if (!hospitalId) return jsonError("Hospital ID is required.");

  const { data: clinic, error: clinicError } = await admin
    .from("clinics")
    .select("id, name")
    .eq("id", hospitalId)
    .maybeSingle();
  if (clinicError) {
    console.error("Could not load hospital before removal.", clinicError);
    return jsonError("Could not load hospital before removal.", 500);
  }
  if (!clinic) return jsonError("Hospital not found.", 404);

  const { data: departmentRows, error: departmentsError } = await admin
    .from("departments")
    .select("id")
    .eq("clinic_id", hospitalId);
  if (departmentsError) {
    console.error("Could not load hospital departments before removal.", departmentsError);
    return jsonError("Could not load hospital departments before removal.", 500);
  }

  const { data: profileRows, error: profilesError } = await admin
    .from("profiles")
    .select("id")
    .eq("clinic_id", hospitalId);
  if (profilesError) {
    console.error("Could not load hospital users before removal.", profilesError);
    return jsonError("Could not load hospital users before removal.", 500);
  }

  const departmentIds = (departmentRows ?? []).map((department) => department.id);
  const profileIds = (profileRows ?? []).map((profile) => profile.id);

  try {
    const { data: scanRows, error: scansLoadError } = await admin
      .from("scans")
      .select("id")
      .eq("clinic_id", hospitalId);
    if (scansLoadError) throw scansLoadError;
    const scanIds = (scanRows ?? []).map((scan) => scan.id);

    const { data: reportRows, error: reportsLoadError } = await admin
      .from("reports")
      .select("id")
      .eq("clinic_id", hospitalId);
    if (reportsLoadError) throw reportsLoadError;
    const reportIds = (reportRows ?? []).map((report) => report.id);

    if (scanIds.length > 0) {
      const { error } = await admin.from("ai_results").delete().in("scan_id", scanIds);
      if (error) throw error;
    }
    if (reportIds.length > 0) {
      const { error } = await admin.from("report_versions").delete().in("report_id", reportIds);
      if (error) throw error;
    }
    if (departmentIds.length > 0) {
      const { error } = await admin.from("department_users").delete().in("department_id", departmentIds);
      if (error) throw error;
    }

    const deleteByClinic = async (table: string) => {
      const { error } = await admin.from(table).delete().eq("clinic_id", hospitalId);
      if (error) throw error;
    };

    await deleteByClinic("reports");
    await deleteByClinic("scans");
    await deleteByClinic("patients");
    await deleteByClinic("feedback_entries");
    await deleteByClinic("profiles");
    await deleteByClinic("clinic_modules");
    await deleteByClinic("module_api_keys");
    await deleteByClinic("departments");

    const { error: clinicDeleteError } = await admin.from("clinics").delete().eq("id", hospitalId);
    if (clinicDeleteError) throw clinicDeleteError;

    await Promise.all(profileIds.map((profileId) => admin.auth.admin.deleteUser(profileId).catch(() => undefined)));

    await admin.from("audit_logs").insert({
      user_id: authData.user.id,
      action: "Hospital removed",
      record_type: "hospital",
      record_id: hospitalId,
      details: { message: `${clinic.name} removed with related access records` }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Hospital removal failed.", error);
    return jsonError("Could not fully remove hospital.", 500);
  }
}
