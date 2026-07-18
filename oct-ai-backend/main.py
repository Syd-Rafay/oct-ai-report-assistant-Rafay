import os
import base64
import hashlib
import hmac
import json
import smtplib
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import requests
import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from torchvision import models, transforms


CLASSES = ["CNV", "DME", "DRUSEN", "NORMAL"]
MODEL_NAME = "EfficientNet-B3"
MODEL_VERSION = "v1.1"
DISCLAIMER = "AI-assisted preliminary result. Requires doctor review."
INVALID_IMAGE_DISCLAIMER = "This does not appear to be a valid OCT scan. Please upload an OCT image."
LOW_CONFIDENCE_DISCLAIMER = "Uploaded image may not be a valid OCT scan or confidence is too low. Requires doctor review."
MODEL_PATH = Path(os.getenv("MODEL_PATH", "best_oct_model_b3.pth"))
MIN_CONFIDENCE = float(os.getenv("MIN_OCT_CONFIDENCE", "0.70"))
ENABLE_GRADCAM = os.getenv("ENABLE_GRADCAM", "false").lower() == "true"
MAX_GRADCAM_DIMENSION = int(os.getenv("MAX_GRADCAM_DIMENSION", "600"))
DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:3000,http://localhost:3000"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://cvclinics.online").rstrip("/")
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "OCT AI Report Assistant")
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", SMTP_FROM_EMAIL)
RESEND_FROM_NAME = os.getenv("RESEND_FROM_NAME", SMTP_FROM_NAME)
AI_GATEWAY_SHARED_SECRET = os.getenv("AI_GATEWAY_SHARED_SECRET", "")
ACCESS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

app = FastAPI(title="OCT AI Backend", version=MODEL_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))

preprocess = transforms.Compose(
    [
        transforms.Resize((300, 300)),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225],
        ),
    ]
)


def build_model() -> torch.nn.Module:
    model = models.efficientnet_b3(weights=None)
    in_features = model.classifier[1].in_features
    model.classifier[1] = torch.nn.Linear(in_features, len(CLASSES))
    return model


def jet_colorize_heatmap(heatmap_array: np.ndarray) -> np.ndarray:
    """Approximate OpenCV COLORMAP_JET without adding an OpenCV dependency."""
    x = np.clip(heatmap_array, 0.0, 1.0)
    red = np.clip(1.5 - np.abs(4.0 * x - 3.0), 0.0, 1.0)
    green = np.clip(1.5 - np.abs(4.0 * x - 2.0), 0.0, 1.0)
    blue = np.clip(1.5 - np.abs(4.0 * x - 1.0), 0.0, 1.0)
    return np.stack([red, green, blue], axis=-1) * 255.0


def gradcam_overlay_png_data_url(image: Image.Image, heatmap: np.ndarray) -> str:
    overlay_image = image.convert("RGB")
    longest_side = max(overlay_image.size)
    if longest_side > MAX_GRADCAM_DIMENSION:
        ratio = MAX_GRADCAM_DIMENSION / longest_side
        overlay_image = overlay_image.resize(
            (max(1, round(overlay_image.width * ratio)), max(1, round(overlay_image.height * ratio))),
            Image.Resampling.LANCZOS,
        )

    heatmap_image = Image.fromarray(np.uint8(heatmap * 255), mode="L").resize(overlay_image.size, Image.Resampling.BICUBIC)
    heatmap_array = np.array(heatmap_image).astype(float) / 255.0
    base = np.array(overlay_image).astype(float)
    color = jet_colorize_heatmap(heatmap_array)
    overlay = np.uint8(np.clip(color * 0.4 + base * 0.6, 0, 255))

    output = BytesIO()
    Image.fromarray(overlay).save(output, format="PNG")
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def gradcam_overlay_base64(image: Image.Image, image_tensor: torch.Tensor, class_index: int) -> str | None:
    if model is None or not ENABLE_GRADCAM:
        return None

    activations: list[torch.Tensor] = []
    gradients: list[torch.Tensor] = []
    target_layer = model.features[-1]

    def forward_hook(_module: torch.nn.Module, _inputs: tuple[torch.Tensor, ...], output: torch.Tensor) -> None:
        activations.append(output.detach())

    def backward_hook(_module: torch.nn.Module, _grad_input: tuple[torch.Tensor, ...], grad_output: tuple[torch.Tensor, ...]) -> None:
        gradients.append(grad_output[0].detach())

    forward_handle = target_layer.register_forward_hook(forward_hook)
    backward_handle = target_layer.register_full_backward_hook(backward_hook)

    try:
        model.zero_grad(set_to_none=True)
        with torch.enable_grad():
            logits = model(image_tensor)
            score = logits[:, class_index].sum()
            score.backward()

        if not activations or not gradients:
            return None

        feature_maps = activations[-1][0]
        gradient_maps = gradients[-1][0]
        weights = gradient_maps.mean(dim=(1, 2), keepdim=True)
        heatmap = torch.relu((weights * feature_maps).sum(dim=0))
        heatmap_max = torch.max(heatmap)
        if float(heatmap_max) <= 0:
            return None

        return gradcam_overlay_png_data_url(image, (heatmap / heatmap_max).cpu().numpy())
    except Exception:
        return None
    finally:
        forward_handle.remove()
        backward_handle.remove()
        model.zero_grad(set_to_none=True)


def predict_tensor(image_tensor: torch.Tensor) -> tuple[dict[str, float], str, float]:
    with torch.inference_mode():
        logits = model(image_tensor)
        softmax = torch.softmax(logits, dim=1).squeeze(0).cpu()

    probabilities = {
        class_name: round(float(softmax[index]), 4)
        for index, class_name in enumerate(CLASSES)
    }
    prediction = max(probabilities, key=probabilities.get)
    confidence = probabilities[prediction]
    return probabilities, prediction, confidence


def gradcam_prediction_and_overlay(image: Image.Image, image_tensor: torch.Tensor) -> tuple[dict[str, float], str, float, str | None]:
    if model is None or not ENABLE_GRADCAM:
        return {}, "INVALID_IMAGE", 0.0, None

    activations: list[torch.Tensor] = []
    gradients: list[torch.Tensor] = []
    probabilities: dict[str, float] = {}
    prediction = "INVALID_IMAGE"
    confidence = 0.0
    target_layer = model.features[-1]

    def forward_hook(_module: torch.nn.Module, _inputs: tuple[torch.Tensor, ...], output: torch.Tensor) -> None:
        activations.append(output.detach())

    def backward_hook(_module: torch.nn.Module, _grad_input: tuple[torch.Tensor, ...], grad_output: tuple[torch.Tensor, ...]) -> None:
        gradients.append(grad_output[0].detach())

    forward_handle = target_layer.register_forward_hook(forward_hook)
    backward_handle = target_layer.register_full_backward_hook(backward_hook)

    try:
        model.zero_grad(set_to_none=True)
        with torch.enable_grad():
            logits = model(image_tensor)

        softmax = torch.softmax(logits, dim=1).squeeze(0).cpu()
        probabilities = {
            class_name: round(float(softmax[index]), 4)
            for index, class_name in enumerate(CLASSES)
        }
        prediction = max(probabilities, key=probabilities.get)
        confidence = probabilities[prediction]

        if confidence < MIN_CONFIDENCE:
            return probabilities, prediction, confidence, None

        score = logits[:, CLASSES.index(prediction)].sum()
        score.backward()

        if not activations or not gradients:
            return probabilities, prediction, confidence, None

        feature_maps = activations[-1][0]
        gradient_maps = gradients[-1][0]
        weights = gradient_maps.mean(dim=(1, 2), keepdim=True)
        heatmap = torch.relu((weights * feature_maps).sum(dim=0))
        heatmap_max = torch.max(heatmap)
        if float(heatmap_max) <= 0:
            return probabilities, prediction, confidence, None

        return probabilities, prediction, confidence, gradcam_overlay_png_data_url(image, (heatmap / heatmap_max).cpu().numpy())
    except Exception:
        return probabilities, prediction, confidence, None
    finally:
        forward_handle.remove()
        backward_handle.remove()
        model.zero_grad(set_to_none=True)


async def verify_ai_gateway_signature(request: Request, file: UploadFile) -> None:
    timestamp = request.headers.get("X-AFIO-Timestamp")
    signature = request.headers.get("X-AFIO-Signature")

    if not timestamp or not signature:
        raise HTTPException(status_code=401, detail="Missing AFIO signature headers.")

    try:
        timestamp_ms = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid AFIO timestamp.") from exc

    now_ms = int(time.time() * 1000)
    if now_ms - timestamp_ms > 5 * 60 * 1000:
        raise HTTPException(status_code=403, detail="AFIO signature has expired.")

    if not AI_GATEWAY_SHARED_SECRET:
        raise HTTPException(status_code=500, detail="AI gateway shared secret is not configured.")

    image_bytes = await file.read()
    payload = base64.b64encode(image_bytes).decode("ascii")
    expected_signature = hmac.new(
        AI_GATEWAY_SHARED_SECRET.encode("utf-8"),
        f"{timestamp}.{payload}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    await file.seek(0)

    if not hmac.compare_digest(expected_signature, signature):
        raise HTTPException(status_code=403, detail="Invalid AFIO signature.")


async def read_oct_upload(file: UploadFile) -> Image.Image:
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(
            status_code=400,
            detail="Only JPG, JPEG, and PNG OCT images are supported.",
        )

    try:
        image_bytes = await file.read()
        return Image.open(BytesIO(image_bytes)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image file.") from exc


def clean_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    if isinstance(checkpoint, torch.nn.Module):
        return checkpoint.state_dict()

    if isinstance(checkpoint, dict):
        for key in ("model_state_dict", "state_dict", "model"):
            nested = checkpoint.get(key)
            if isinstance(nested, dict):
                checkpoint = nested
                break

    if not isinstance(checkpoint, dict):
        raise RuntimeError("Unsupported model checkpoint format.")

    cleaned = {}
    for key, value in checkpoint.items():
        if key.startswith("module."):
            key = key[len("module.") :]
        cleaned[key] = value
    return cleaned


def load_model() -> tuple[torch.nn.Module | None, str | None]:
    if not MODEL_PATH.exists():
        return None, f"Model file not found: {MODEL_PATH}"

    try:
        model = build_model()
        checkpoint = torch.load(MODEL_PATH, map_location=device)
        model.load_state_dict(clean_state_dict(checkpoint), strict=True)
        model.to(device)
        model.eval()
        return model, None
    except Exception as exc:
        return None, str(exc)


model, model_error = load_model()


class ReportCheckRequest(BaseModel):
    access_id: str
    password: str


class ReportPasswordChangeRequest(BaseModel):
    access_id: str
    old_password: str
    new_password: str


class ReportAccessEmailRequest(BaseModel):
    to_email: str
    patient_name: str
    access_id: str
    password: str
    mode: str = "report-ready"


class FeedbackEmailRequest(BaseModel):
    to_email: str
    patient_name: str
    feedback_type: str = "feedback"
    mode: str = "registered"
    body: str = ""


class FeedbackCreateRequest(BaseModel):
    type: str
    clinic_id: str | None = None
    hospital_name: str | None = None
    module_id: str | None = None
    name: str
    email: str | None = None
    phone: str | None = None
    patient_code: str | None = None
    report_id: str | None = None
    message: str


class FeedbackStatusRequest(BaseModel):
    status: str


class FeedbackResponseRequest(BaseModel):
    responder_name: str
    message: str


def basic_oct_image_check(image: Image.Image) -> bool:
    rgb = np.array(image.convert("RGB").resize((300, 300)))
    gray = np.array(image.convert("L").resize((300, 300)))
    hsv = np.array(image.convert("HSV").resize((300, 300)))

    contrast = float(gray.std())
    brightness = float(gray.mean())
    dark_ratio = float((gray < 45).mean())
    very_bright_ratio = float((gray > 235).mean())
    midtone_ratio = float(((gray >= 45) & (gray <= 220)).mean())
    saturation = hsv[:, :, 1]
    saturation_mean = float(saturation.mean())
    saturation_p90 = float(np.percentile(saturation, 90))

    red_green = np.abs(rgb[:, :, 0].astype(float) - rgb[:, :, 1].astype(float)).mean()
    green_blue = np.abs(rgb[:, :, 1].astype(float) - rgb[:, :, 2].astype(float)).mean()
    color_delta = float((red_green + green_blue) / 2)
    row_std = gray.std(axis=1)
    row_bright_ratio = (gray > 95).mean(axis=1)
    row_dark_ratio = (gray < 45).mean(axis=1)
    retinal_band_rows = (row_std > 20) & (row_bright_ratio > 0.18)
    max_band_run = 0
    current_band_run = 0
    for is_band_row in retinal_band_rows:
        current_band_run = current_band_run + 1 if is_band_row else 0
        max_band_run = max(max_band_run, current_band_run)
    margin_dark_ratio = float((row_dark_ratio[:45].mean() + row_dark_ratio[-45:].mean()) / 2)

    if contrast < 20:
        return False

    if brightness < 10 or brightness > 245:
        return False

    # Reject mostly white documents, circuit diagrams, and clean screenshots. OCT
    # B-scans normally contain substantial dark background plus a noisy retinal band.
    if brightness > 190 and very_bright_ratio > 0.45:
        return False

    has_grayscale_retinal_band = saturation_p90 <= 5 and 8 <= max_band_run <= 120 and contrast > 35
    if dark_ratio < 0.22 and margin_dark_ratio < 0.22 and not has_grayscale_retinal_band:
        return False

    if midtone_ratio < 0.08:
        return False

    # OCT B-scans are usually grayscale-like. Strong color differences often mean
    # the upload is a normal photo, screenshot, fundus photo, or other non-OCT image.
    if color_delta > 18 or saturation_mean > 18 or saturation_p90 > 60:
        return False

    # Real B-scans usually have a bounded retinal band surrounded by dark space.
    # Natural photos often have texture across most rows; diagrams often lack a
    # sustained retinal band.
    if max_band_run < 5 or max_band_run > 180:
        return False

    return True


def fnv1a(seed: str) -> int:
    hash_value = 2166136261
    for char in seed:
        hash_value ^= ord(char)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return hash_value


def get_report_access_password(report_id: str, created_at: str) -> str:
    value = fnv1a(f"{report_id}:{created_at}")
    password = ""
    for _ in range(7):
        value = (value * 1664525 + 1013904223) & 0xFFFFFFFF
        password += ACCESS_ALPHABET[value % len(ACCESS_ALPHABET)]
    return password


def get_patient_access_password(patient_id: str, created_at: str) -> str:
    value = fnv1a(f"{patient_id}:{created_at}")
    password = ""
    for _ in range(7):
        value = (value * 1664525 + 1013904223) & 0xFFFFFFFF
        password += ACCESS_ALPHABET[value % len(ACCESS_ALPHABET)]
    return password


def access_id_digits(value: str | None) -> str:
    return "".join(char for char in (value or "") if char.isdigit())


def find_patient_by_access_id(access_id: str) -> dict[str, Any] | None:
    access_id = access_id.strip()
    access_digits = access_id_digits(access_id)
    patient = first_row("patients", {"patient_code": f"eq.{access_digits or access_id}", "select": "*"})
    if not patient and access_id != access_digits:
        patient = first_row("patients", {"patient_code": f"eq.{access_id}", "select": "*"})
    if not patient and access_digits:
        patient = first_row("patients", {"cnic": f"eq.{access_digits}", "select": "*"})
    if not patient and access_digits:
        formatted_cnic = f"{access_digits[:5]}-{access_digits[5:12]}-{access_digits[12:]}" if len(access_digits) == 13 else access_digits
        patient = first_row("patients", {"cnic": f"eq.{formatted_cnic}", "select": "*"})
    return patient


def expected_patient_password(patient: dict[str, Any]) -> str:
    return patient.get("access_password") or get_patient_access_password(patient["id"], patient["created_at"])


def supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def supabase_select(table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    if not supabase_configured():
        raise RuntimeError("Supabase service credentials are not configured.")

    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}?{query}",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            import json

            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase request failed: {detail}") from exc


def supabase_write(table: str, payload: dict[str, Any], method: str = "POST", params: dict[str, str] | None = None) -> list[dict[str, Any]]:
    if not supabase_configured():
        raise RuntimeError("Supabase service credentials are not configured.")

    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    request = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}{query}",
        data=json.dumps(payload).encode("utf-8"),
        method=method,
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=representation",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else []
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase request failed: {detail}") from exc


def first_row(table: str, params: dict[str, str]) -> dict[str, Any] | None:
    rows = supabase_select(table, params)
    return rows[0] if rows else None


def smtp_configured() -> bool:
    return bool(SMTP_HOST and SMTP_PORT and SMTP_USERNAME and SMTP_PASSWORD and SMTP_FROM_EMAIL)


def resend_configured() -> bool:
    return bool(RESEND_API_KEY and RESEND_FROM_EMAIL)


def email_configured() -> bool:
    return resend_configured() or smtp_configured()


def patient_safe_report_text(value: str) -> str:
    return (
        value.replace("AI-assisted classification suggests", "Doctor-reviewed results show")
        .replace("AI-assisted Classification suggests", "Doctor-reviewed results show")
        .replace("based on AI-assisted analysis", "after doctor review")
        .replace("AI-assisted", "Doctor-reviewed")
        .replace(" AI ", " doctor-reviewed analysis ")
    )


def send_plain_email(to_email: str, subject: str, text_content: str) -> None:
    if resend_configured():
        payload = {
            "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
            "to": [to_email],
            "subject": subject,
            "text": text_content,
        }
        try:
            response = requests.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {RESEND_API_KEY}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=payload,
                timeout=20,
            )
            response.raise_for_status()
            return
        except requests.HTTPError as exc:
            detail = exc.response.text if exc.response is not None else str(exc)
            raise HTTPException(status_code=502, detail=f"Email sending failed: {detail}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Email sending failed: {exc}") from exc

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
    message["To"] = to_email
    message.set_content(text_content)

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as server:
            server.starttls(context=context)
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.send_message(message)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Email sending failed: {exc}") from exc


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "OCT AI Backend",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "disclaimer": DISCLAIMER,
    }


@app.get("/health")
def health():
    return {
        "status": "ok" if model is not None else "model_error",
        "model_loaded": model is not None,
        "model_path": str(MODEL_PATH),
        "device": str(device),
        "error": model_error,
    }


@app.post("/reports/check")
def check_report_access(input_data: ReportCheckRequest):
    if not supabase_configured():
        return {
            "configured": False,
            "found": False,
            "approved": False,
            "message": "Public report lookup is not configured on the backend.",
        }

    access_id = input_data.access_id.strip()
    password = input_data.password.strip()
    if not access_id or not password:
        raise HTTPException(status_code=400, detail="Access ID and password are required.")

    try:
        patient = find_patient_by_access_id(access_id)
        if not patient:
            return {"configured": True, "found": False, "approved": False, "message": "No matching patient access record found."}

        expected_password = expected_patient_password(patient)
        if password != expected_password:
            return {"configured": True, "found": False, "approved": False, "message": "Invalid access ID or password."}

        reports = supabase_select(
            "reports",
            {
                "patient_id": f"eq.{patient['id']}",
                "order": "approved_at.desc.nullslast,created_at.desc",
                "select": "*",
            },
        )
        visible_reports = [
            row
            for row in reports
            if row.get("status") in ("approved", "rejected", "superseded")
        ]

        def public_report_payload(report_row: dict[str, Any]) -> dict[str, Any]:
            ai_result_row = first_row("ai_results", {"id": f"eq.{report_row['ai_result_id']}", "select": "*"}) if report_row.get("ai_result_id") else None
            approver_row = (
                first_row("profiles", {"id": f"eq.{report_row['approved_by']}", "select": "full_name"})
                if report_row.get("approved_by")
                else None
            )
            final_result = report_row.get("final_diagnosis") or "Needs clinical correlation"
            if final_result == "Needs clinical correlation" and ai_result_row:
                final_result = ai_result_row.get("predicted_class") or final_result

            return {
                "id": report_row["id"],
                "patientCode": access_id_digits(patient.get("cnic")) or patient.get("patient_code", ""),
                "patientName": patient.get("full_name", ""),
                "age": patient.get("age"),
                "gender": patient.get("gender"),
                "result": final_result,
                "findings": patient_safe_report_text(report_row.get("findings") or ""),
                "impression": patient_safe_report_text(report_row.get("impression") or ""),
                "recommendation": patient_safe_report_text(report_row.get("recommendation") or ""),
                "doctorNotes": patient_safe_report_text(report_row.get("doctor_notes") or ""),
                "finalDiagnosis": final_result,
                "approvedByName": approver_row.get("full_name") if approver_row else "",
                "approvedAt": report_row.get("approved_at"),
                "createdAt": report_row.get("created_at"),
                "status": report_row.get("status"),
            }

        report_history = [public_report_payload(row) for row in visible_reports]
        report = next((row for row in reports if row.get("status") == "approved"), None)
        if not report:
            return {
                "configured": True,
                "found": True,
                "approved": False,
                "status": reports[0]["status"] if reports else "draft",
                "reports": report_history,
                "message": "Patient access is valid, but no approved report is available yet.",
            }

        primary_report = public_report_payload(report)

        return {
            "configured": True,
            "found": True,
            "approved": True,
            "status": report["status"],
            "report": primary_report,
            "reports": report_history,
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/reports/change-access-password")
def change_report_access_password(input_data: ReportPasswordChangeRequest):
    if not supabase_configured():
        raise HTTPException(status_code=503, detail="Public report lookup is not configured on the backend.")

    access_id = input_data.access_id.strip()
    old_password = input_data.old_password.strip()
    new_password = input_data.new_password.strip()
    if not access_id or not old_password or not new_password:
        raise HTTPException(status_code=400, detail="Access ID, old password, and new password are required.")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters.")

    try:
        patient = find_patient_by_access_id(access_id)
        if not patient:
            raise HTTPException(status_code=404, detail="No matching patient access record found.")

        if old_password != expected_patient_password(patient):
            raise HTTPException(status_code=400, detail="Old password is incorrect.")

        supabase_write(
            "patients",
            {"access_password": new_password, "updated_at": utc_now()},
            method="PATCH",
            params={"id": f"eq.{patient['id']}"},
        )
        return {"changed": True, "message": "Patient password updated. Use the new password next time."}
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/reports/send-access-email")
def send_report_access_email(input_data: ReportAccessEmailRequest):
    if not email_configured():
        fallback_message = (
            "Patient saved, but backend email settings are not configured. Copy and send the access ID/password manually."
            if input_data.mode == "patient-created"
            else "Report approved, but backend email settings are not configured. Copy and send the access ID/password manually."
        )
        return {
            "sent": False,
            "configured": False,
            "message": fallback_message,
        }

    report_url = f"{FRONTEND_URL}/reports/check"
    subject = (
        "Your OCT report access details"
        if input_data.mode == "patient-created"
        else "Your OCT report has been registered"
        if input_data.mode == "report-registered"
        else "Your OCT report is ready"
    )
    text_content = "\n".join(
        [
            f"Hello {input_data.patient_name},",
            "",
            (
                "Your patient record has been created. Use the details below to check your OCT report status once your scan/report is completed."
                if input_data.mode == "patient-created"
                else "Your OCT report has been registered and is waiting for doctor review. You can use the details below to check when it becomes available."
                if input_data.mode == "report-registered"
                else "Your OCT report has been reviewed and approved by the doctor. It is ready to view, download, and print."
            ),
            "",
            f"Access ID: {input_data.access_id}",
            f"Access password: {input_data.password}",
            f"Open: {report_url}",
            "",
            "Please contact the clinic if you have questions.",
        ]
    )

    send_plain_email(input_data.to_email, subject, text_content)

    return {
        "sent": True,
        "configured": True,
        "message": (
            "Patient saved and access email sent."
            if input_data.mode == "patient-created"
            else "Report registration email sent to the patient."
            if input_data.mode == "report-registered"
            else "Report approved and ready email sent to the patient."
        ),
    }


@app.post("/feedback/send-email")
def send_feedback_email(input_data: FeedbackEmailRequest):
    if not email_configured():
        return {
            "sent": False,
            "configured": False,
            "message": "Feedback saved, but backend email settings are not configured.",
        }

    feedback_label = "complaint" if input_data.feedback_type == "complaint" else "feedback"
    if input_data.mode == "response":
        subject = f"Response to your {feedback_label}"
        text_content = "\n".join(
            [
                f"Hello {input_data.patient_name},",
                "",
                f"Thank you for contacting us about your {feedback_label}. Our team has reviewed your message and has shared the response below.",
                "",
                input_data.body.strip() or "Your message has been reviewed by our team.",
                "",
                "If you need any further help, please reply to this email or contact the clinic directly.",
                "",
                "Regards,",
                "OCT Report Assistant Team",
            ]
        )
        success_message = "Response email sent to the patient."
    else:
        subject = f"Your {feedback_label} has been acknowledged"
        text_content = "\n".join(
            [
                f"Hello {input_data.patient_name},",
                "",
                f"Your {feedback_label} has been received and acknowledged by the clinic team.",
                "We will review it and respond as soon as possible if a reply is needed.",
                "",
                "Regards,",
                "OCT Report Assistant Team",
            ]
        )
        success_message = f"{feedback_label.title()} acknowledgement email sent."

    send_plain_email(input_data.to_email, subject, text_content)
    return {"sent": True, "configured": True, "message": success_message}


def map_feedback_entry(row: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": row.get("id", ""),
        "type": row.get("type", "feedback"),
        "clinicId": row.get("clinic_id") or "",
        "hospitalName": row.get("hospital_name") or "",
        "moduleId": row.get("module_id") or "",
        "name": row.get("name", ""),
        "email": row.get("email") or "",
        "phone": row.get("phone") or "",
        "patientCode": row.get("patient_code") or "",
        "reportId": row.get("report_id") or "",
        "message": row.get("message", ""),
        "status": row.get("status", "new"),
        "createdAt": row.get("created_at", ""),
        "responses": [
            {
                "id": message.get("id", ""),
                "message": message.get("message", ""),
                "responderName": message.get("responder_name", ""),
                "createdAt": message.get("created_at", ""),
            }
            for message in messages
            if message.get("feedback_id") == row.get("id")
        ],
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def feedback_error_detail(error: RuntimeError) -> str:
    message = str(error)
    if "feedback_entries" in message or "feedback_messages" in message or "relation" in message:
        return "Feedback storage is not set up yet. Run supabase/feedback.sql in the Supabase SQL editor, then try again."
    return message


@app.get("/feedback")
def list_feedback():
    try:
        entries = supabase_select("feedback_entries", {"select": "*", "order": "created_at.desc"})
        messages = supabase_select("feedback_messages", {"select": "*", "order": "created_at.desc"})
        return {"configured": True, "entries": [map_feedback_entry(entry, messages) for entry in entries]}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=feedback_error_detail(exc)) from exc


@app.post("/feedback")
def create_feedback(input_data: FeedbackCreateRequest):
    feedback_type = input_data.type.strip().lower()
    if feedback_type not in {"feedback", "complaint"}:
        raise HTTPException(status_code=400, detail="Feedback type must be feedback or complaint.")
    if not input_data.name.strip() or not input_data.message.strip():
        raise HTTPException(status_code=400, detail="Name and message are required.")

    try:
        rows = supabase_write(
            "feedback_entries",
            {
                "type": feedback_type,
                "clinic_id": (input_data.clinic_id or "").strip() or None,
                "hospital_name": (input_data.hospital_name or "").strip() or None,
                "module_id": (input_data.module_id or "").strip() or None,
                "name": input_data.name.strip(),
                "email": (input_data.email or "").strip() or None,
                "phone": (input_data.phone or "").strip() or None,
                "patient_code": (input_data.patient_code or "").strip() or None,
                "report_id": (input_data.report_id or "").strip() or None,
                "message": input_data.message.strip(),
                "status": "new",
            },
        )
        entry = rows[0] if rows else {}
        return {"configured": True, "entry": map_feedback_entry(entry, [])}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=feedback_error_detail(exc)) from exc


@app.patch("/feedback/{feedback_id}/status")
def update_feedback_status(feedback_id: str, input_data: FeedbackStatusRequest):
    status = input_data.status.strip().lower()
    if status not in {"new", "reviewing", "resolved"}:
        raise HTTPException(status_code=400, detail="Invalid feedback status.")

    try:
        rows = supabase_write(
            "feedback_entries",
            {"status": status, "updated_at": utc_now()},
            method="PATCH",
            params={"id": f"eq.{feedback_id}"},
        )
        entry = rows[0] if rows else {}
        return {"configured": True, "entry": map_feedback_entry(entry, [])}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=feedback_error_detail(exc)) from exc


@app.post("/feedback/{feedback_id}/responses")
def add_feedback_response(feedback_id: str, input_data: FeedbackResponseRequest):
    if not input_data.responder_name.strip() or not input_data.message.strip():
        raise HTTPException(status_code=400, detail="Responder name and message are required.")

    try:
        message_rows = supabase_write(
            "feedback_messages",
            {
                "feedback_id": feedback_id,
                "responder_name": input_data.responder_name.strip(),
                "message": input_data.message.strip(),
            },
        )
        supabase_write(
            "feedback_entries",
            {"status": "resolved", "updated_at": utc_now()},
            method="PATCH",
            params={"id": f"eq.{feedback_id}"},
        )
        return {"configured": True, "response": message_rows[0] if message_rows else {}}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=feedback_error_detail(exc)) from exc


@app.post("/predict")
async def predict(request: Request, file: UploadFile = File(...)):
    started_at = time.perf_counter()
    await verify_ai_gateway_signature(request, file)
    if model is None:
        raise HTTPException(
            status_code=503,
            detail=f"AI model is not loaded. {model_error}",
        )

    image = await read_oct_upload(file)

    try:
        if not basic_oct_image_check(image):
            return {
                "prediction": "INVALID_IMAGE",
                "confidence": 0,
                "probabilities": {},
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "is_valid_oct": False,
                "gradcam_overlay_base64": None,
                "disclaimer": INVALID_IMAGE_DISCLAIMER,
            }

        image_tensor = preprocess(image).unsqueeze(0).to(device)
        probabilities, prediction, confidence = predict_tensor(image_tensor)
        inference_time_ms = round((time.perf_counter() - started_at) * 1000)

        if confidence < MIN_CONFIDENCE:
            return {
                "prediction": "INVALID_OR_UNCERTAIN_IMAGE",
                "confidence": confidence,
                "probabilities": probabilities,
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "inference_time_ms": inference_time_ms,
                "is_valid_oct": False,
                "gradcam_overlay_base64": None,
                "disclaimer": LOW_CONFIDENCE_DISCLAIMER,
            }

        return {
            "prediction": prediction,
            "confidence": confidence,
            "probabilities": probabilities,
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "inference_time_ms": inference_time_ms,
            "is_valid_oct": True,
            "gradcam_overlay_base64": None,
            "disclaimer": DISCLAIMER,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {exc}") from exc


@app.post("/gradcam")
async def gradcam(request: Request, file: UploadFile = File(...)):
    started_at = time.perf_counter()
    await verify_ai_gateway_signature(request, file)
    if not ENABLE_GRADCAM:
        raise HTTPException(
            status_code=503,
            detail="Grad-CAM is disabled on this backend. Enable it only on a memory-safe worker.",
        )
    if model is None:
        raise HTTPException(
            status_code=503,
            detail=f"AI model is not loaded. {model_error}",
        )

    image = await read_oct_upload(file)

    try:
        if not basic_oct_image_check(image):
            return {
                "prediction": "INVALID_IMAGE",
                "confidence": 0,
                "probabilities": {},
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "is_valid_oct": False,
                "gradcam_overlay_base64": None,
                "disclaimer": INVALID_IMAGE_DISCLAIMER,
            }

        image_tensor = preprocess(image).unsqueeze(0).to(device)
        probabilities, prediction, confidence, overlay = gradcam_prediction_and_overlay(image, image_tensor)

        if confidence < MIN_CONFIDENCE:
            return {
                "prediction": "INVALID_OR_UNCERTAIN_IMAGE",
                "confidence": confidence,
                "probabilities": probabilities,
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "is_valid_oct": False,
                "gradcam_overlay_base64": None,
                "disclaimer": LOW_CONFIDENCE_DISCLAIMER,
            }

        return {
            "prediction": prediction,
            "confidence": confidence,
            "probabilities": probabilities,
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "inference_time_ms": round((time.perf_counter() - started_at) * 1000),
            "is_valid_oct": True,
            "gradcam_overlay_base64": overlay,
            "gradcam_disclaimer": "Highlighted regions indicate areas that influenced the AI classification. This is not a segmentation map or measurement.",
            "disclaimer": DISCLAIMER,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Grad-CAM generation failed: {exc}") from exc
