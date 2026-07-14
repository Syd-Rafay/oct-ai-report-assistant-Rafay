import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const backendUrl = (
    process.env.NEXT_PUBLIC_RETINA_DR_GRADCAM_BACKEND_URL ||
    process.env.NEXT_PUBLIC_RETINA_GRADCAM_BACKEND_URL ||
    ""
  ).replace(/\/$/, "");

  if (!backendUrl) {
    return NextResponse.json({ error: "Retina DR Grad-CAM backend is not configured." }, { status: 503 });
  }

  const incoming = await request.formData();
  const file = incoming.get("image") ?? incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image file uploaded." }, { status: 400 });
  }

  const forward = new FormData();
  forward.append("image", file, file.name || "retina-scan.jpg");

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/gradcam`, {
      method: "POST",
      body: forward
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Retina DR Grad-CAM backend." }, { status: 502 });
  }

  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || "Retina DR Grad-CAM backend returned a non-JSON response." };
  }

  return NextResponse.json(payload, { status: response.status });
}
