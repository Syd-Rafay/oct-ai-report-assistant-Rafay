import os
import json
import smtplib
import ssl
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import requests
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from torchvision import models, transforms


CLASSES = ["CNV", "DME", "DRUSEN", "NORMAL"]
MODEL_NAME = "EfficientNet-B3"
MODEL_VERSION = "v1.0"
DISCLAIMER = "AI-assisted preliminary result. Requires doctor review."
INVALID_IMAGE_DISCLAIMER = "This does not appear to be a valid OCT scan. Please upload an OCT image."
LOW_CONFIDENCE_DISCLAIMER = "Uploaded image may not be a valid OCT scan or confidence is too low. Requires doctor review."
MODEL_PATH = Path(os.getenv("MODEL_PATH", "best_oct_model_b3.pth"))
MIN_CONFIDENCE = float(os.getenv("MIN_OCT_CONFIDENCE", "0.70"))
DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:3000,http://localhost:3000"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://oct-ai-report-assistant.vercel.app").rstrip("/")
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "OCT AI Report Assistant")
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", SMTP_FROM_EMAIL)
RESEND_FROM_NAME = os.getenv("RESEND_FROM_NAME", SMTP_FROM_NAME)
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


def basic_oct_image_check(image: Image.Image) -> bool:
    rgb = np.array(image.convert("RGB").resize((300, 300)))
    gray = np.array(image.convert("L").resize((300, 300)))

    contrast = float(gray.std())
    brightness = float(gray.mean())

    red_green = np.abs(rgb[:, :, 0].astype(float) - rgb[:, :, 1].astype(float)).mean()
    green_blue = np.abs(rgb[:, :, 1].astype(float) - rgb[:, :, 2].astype(float)).mean()
    color_delta = float((red_green + green_blue) / 2)

    if contrast < 20:
        return False

    if brightness < 10 or brightness > 245:
        return False

    # OCT B-scans are usually grayscale-like. Strong color differences often mean
    # the upload is a normal photo, screenshot, fundus photo, or other non-OCT image.
    if color_delta > 18:
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


def first_row(table: str, params: dict[str, str]) -> dict[str, Any] | None:
    rows = supabase_select(table, params)
    return rows[0] if rows else None


def smtp_configured() -> bool:
    return bool(SMTP_HOST and SMTP_PORT and SMTP_USERNAME and SMTP_PASSWORD and SMTP_FROM_EMAIL)


def resend_configured() -> bool:
    return bool(RESEND_API_KEY and RESEND_FROM_EMAIL)


def email_configured() -> bool:
    return resend_configured() or smtp_configured()


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
        patient = first_row("patients", {"patient_code": f"eq.{access_id}", "select": "*"})
        if not patient:
            return {"configured": True, "found": False, "approved": False, "message": "No matching patient access record found."}

        expected_password = get_patient_access_password(patient["id"], patient["created_at"])
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
        report = next((row for row in reports if row.get("status") == "approved"), None)
        if not report:
            return {
                "configured": True,
                "found": True,
                "approved": False,
                "status": reports[0]["status"] if reports else "draft",
                "message": "Patient access is valid, but no approved report is available yet.",
            }

        ai_result = first_row("ai_results", {"id": f"eq.{report['ai_result_id']}", "select": "*"})
        approver = (
            first_row("profiles", {"id": f"eq.{report['approved_by']}", "select": "full_name"})
            if report.get("approved_by")
            else None
        )
        final_result = report.get("final_diagnosis") or "Needs clinical correlation"
        if final_result == "Needs clinical correlation" and ai_result:
            final_result = ai_result.get("predicted_class") or final_result

        return {
            "configured": True,
            "found": True,
            "approved": True,
            "status": report["status"],
            "report": {
                "id": report["id"],
                "patientCode": patient.get("patient_code", ""),
                "patientName": patient.get("full_name", ""),
                "age": patient.get("age"),
                "gender": patient.get("gender"),
                "result": final_result,
                "findings": report.get("findings") or "",
                "impression": report.get("impression") or "",
                "recommendation": report.get("recommendation") or "",
                "doctorNotes": report.get("doctor_notes") or "",
                "finalDiagnosis": final_result,
                "approvedByName": approver.get("full_name") if approver else "",
                "approvedAt": report.get("approved_at"),
            },
        }
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


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if model is None:
        raise HTTPException(
            status_code=503,
            detail=f"AI model is not loaded. {model_error}",
        )

    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(
            status_code=400,
            detail="Only JPG, JPEG, and PNG OCT images are supported.",
        )

    try:
        image_bytes = await file.read()
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image file.") from exc

    try:
        if not basic_oct_image_check(image):
            return {
                "prediction": "INVALID_IMAGE",
                "confidence": 0,
                "probabilities": {},
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "is_valid_oct": False,
                "disclaimer": INVALID_IMAGE_DISCLAIMER,
            }

        image_tensor = preprocess(image).unsqueeze(0).to(device)
        with torch.no_grad():
            logits = model(image_tensor)
            softmax = torch.softmax(logits, dim=1).squeeze(0).cpu()

        probabilities = {
            class_name: round(float(softmax[index]), 4)
            for index, class_name in enumerate(CLASSES)
        }
        prediction = max(probabilities, key=probabilities.get)
        confidence = probabilities[prediction]

        if confidence < MIN_CONFIDENCE:
            return {
                "prediction": "INVALID_OR_UNCERTAIN_IMAGE",
                "confidence": confidence,
                "probabilities": probabilities,
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "is_valid_oct": False,
                "disclaimer": LOW_CONFIDENCE_DISCLAIMER,
            }

        return {
            "prediction": prediction,
            "confidence": confidence,
            "probabilities": probabilities,
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "is_valid_oct": True,
            "disclaimer": DISCLAIMER,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {exc}") from exc
