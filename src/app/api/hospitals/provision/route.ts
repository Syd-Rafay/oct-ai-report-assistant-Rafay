import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

type ModuleId = "oct" | "vkg" | "corneal" | "retina";
type SubscriptionStatus = "trial" | "active" | "past_due" | "suspended";
type DepartmentRow = {
  id: string;
  module_id: ModuleId;
};

const moduleNames: Record<ModuleId, string> = {
  oct: "OCT",
  vkg: "VKG",
  corneal: "Corneal",
  retina: "Retinal Fundus"
};

const departmentNames: Record<ModuleId, string> = {
  oct: "OCT Department",
  vkg: "VKG Department",
  corneal: "Corneal / Keratoconus Department",
  retina: "Retinal Fundus Department"
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function cleanHospitalCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "-");
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value.trim());
}

async function rollbackClinic(admin: any, clinicId: string | null) {
  if (!clinicId) return;
  try {
    await admin.from("clinics").delete().eq("id", clinicId);
  } catch {
    // Best-effort rollback only; the original provisioning error is more useful to report.
  }
}

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function sendWelcomeEmail(input: {
  to: string;
  hospitalName: string;
  password: string;
  enabledModules: ModuleId[];
  activationLink?: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "AFIO Platform <reports@cvclinics.online>";
  if (!apiKey) return { sent: false, reason: "RESEND_API_KEY is not configured." };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://cvclinics.online";
  const modules = input.enabledModules.map((moduleId) => moduleNames[moduleId]).join(", ") || "No modules enabled yet";
  const signInUrl = input.activationLink ?? `${appUrl}/login`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h2>Welcome to AFIO Clinical Report Platform</h2>
      <p>Your hospital workspace for <strong>${input.hospitalName}</strong> is ready.</p>
      <p>Enabled services: <strong>${modules}</strong></p>
      <p>Activate your account here: <a href="${signInUrl}">${signInUrl}</a></p>
      <p><strong>Email:</strong> ${input.to}<br/><strong>Temporary password:</strong> ${input.password}</p>
      <p>Please change this password after your first login.</p>
      <p>Thank you for choosing AFIO clinical services.</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: `Welcome to AFIO - ${input.hospitalName}`,
      html
    })
  });

  if (!response.ok) {
    return { sent: false, reason: await response.text() };
  }
  return { sent: true };
}

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    const missing = [
      !supabaseUrl ? "NEXT_PUBLIC_SUPABASE_URL" : "",
      !supabaseAnonKey ? "NEXT_PUBLIC_SUPABASE_ANON_KEY" : "",
      !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : ""
    ].filter(Boolean);
    return jsonError(`Supabase server provisioning is not configured. Missing: ${missing.join(", ")}`, 500);
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return jsonError("Missing Business Admin session.", 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
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
    return jsonError("Only AFIO Business Admin can provision hospitals.", 403);
  }

  const body = await request.json();
  const name = String(body.name ?? "").trim();
  const code = cleanHospitalCode(String(body.code ?? ""));
  const adminEmail = String(body.adminEmail ?? "").trim().toLowerCase();
  const adminPassword = String(body.adminPassword ?? "").trim() || randomPassword();
  const subscriptionStatus = (body.subscriptionStatus ?? "trial") as SubscriptionStatus;
  const enabledModules = Array.isArray(body.enabledModules)
    ? (body.enabledModules.filter((item: unknown): item is ModuleId =>
        item === "oct" || item === "vkg" || item === "corneal" || item === "retina"
      ))
    : [];

  if (!name || !code) return jsonError("Hospital name and code are required.");
  if (!isEmail(adminEmail)) return jsonError("Hospital admin email is required.");
  if (adminPassword.length < 8) return jsonError("Temporary password must be at least 8 characters.");

  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", adminEmail)
    .maybeSingle();
  if (existingProfile) return jsonError("That admin email already has an AFIO profile.");

  let clinicId: string | null = null;
  let adminUserId: string | null = null;
  try {
    const { data: clinic, error: clinicError } = await admin
      .from("clinics")
      .insert({
        name,
        code,
        admin_email: adminEmail,
        subscription_status: subscriptionStatus,
        is_active: true,
        allow_self_signup: true
      })
      .select("*")
      .single();
    if (clinicError) throw clinicError;
    clinicId = clinic.id;

    const departmentRows = (Object.keys(departmentNames) as ModuleId[]).map((moduleId) => ({
      clinic_id: clinic.id,
      module_id: moduleId,
      name: departmentNames[moduleId],
      is_active: true
    }));
    const { data: departments, error: departmentError } = await admin
      .from("departments")
      .insert(departmentRows)
      .select("*");
    if (departmentError) throw departmentError;
    const departmentList = (departments ?? []) as DepartmentRow[];

    if (enabledModules.length > 0) {
      const { error: moduleError } = await admin.from("clinic_modules").insert(
        enabledModules.map((moduleId: ModuleId) => ({
          clinic_id: clinic.id,
          module_id: moduleId,
          is_enabled: true,
          package_name: subscriptionStatus
        }))
      );
      if (moduleError) throw moduleError;
    }

    const { data: signupLink, error: createUserError } = await admin.auth.admin.generateLink({
      type: "signup",
      email: adminEmail,
      password: adminPassword,
      options: {
        data: {
          full_name: `${name} Admin`,
          role: "hospital_admin",
          clinic_id: clinic.id,
          clinic_name: name
        },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? "https://cvclinics.online"}/login`
      }
    });
    if (createUserError || !signupLink.user) throw createUserError ?? new Error("Could not create hospital admin activation link.");
    adminUserId = signupLink.user.id;

    const defaultDepartment = departmentList.find((department) => department.module_id === (enabledModules[0] ?? "oct")) ?? departmentList[0];
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .insert({
        id: signupLink.user.id,
        full_name: `${name} Admin`,
        email: adminEmail,
        role: "hospital_admin",
        clinic_name: name,
        clinic_id: clinic.id,
        default_department_id: defaultDepartment?.id ?? null,
        is_active: true
      })
      .select("*")
      .single();
    if (profileError) throw profileError;

    const enabledDepartmentRows = departmentList.filter((department) =>
      enabledModules.includes(department.module_id)
    );
    if (enabledDepartmentRows.length > 0) {
      const { error: departmentUserError } = await admin.from("department_users").insert(
        enabledDepartmentRows.map((department) => ({
          department_id: department.id,
          user_id: signupLink.user.id,
          role: "hospital_admin",
          can_view_all: true
        }))
      );
      if (departmentUserError) throw departmentUserError;
    }

    await admin.from("audit_logs").insert({
      user_id: authData.user.id,
      action: "Hospital provisioned",
      record_type: "hospital",
      record_id: clinic.id,
      details: { message: `${name} provisioned with hospital admin ${adminEmail}` }
    });

    const activationLink = signupLink.properties?.action_link;
    const email = await sendWelcomeEmail({ to: adminEmail, hospitalName: name, password: adminPassword, enabledModules, activationLink });

    return NextResponse.json({
      hospital: { ...clinic, clinic_modules: enabledModules.map((moduleId: ModuleId) => ({ module_id: moduleId, is_enabled: true })) },
      profile,
      temporaryPassword: adminPassword,
      activationLink,
      emailSent: email.sent,
      emailMessage: email.sent ? "Welcome email sent." : email.reason
    });
  } catch (error) {
    if (adminUserId) await admin.auth.admin.deleteUser(adminUserId).catch(() => undefined);
    await rollbackClinic(admin, clinicId);
    return jsonError(error instanceof Error ? error.message : "Could not provision hospital.", 500);
  }
}
