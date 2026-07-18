import base64
import hashlib
import hmac
import os
import time
from io import BytesIO
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from tensorflow.keras.models import load_model


MODEL_PATH = Path(os.getenv("CORNEAL_ULCER_MODEL_PATH", "best_model_corneal_ulcer_v6.h5"))
MODEL_NAME = "Group 2 Corneal Ulcer Slit-Lamp Classifier"
MODEL_VERSION = "efficientnetv2b0-corneal-ulcer-v6"
CLASS_NAMES = ["Flaky_Mixed", "PointLike"]
CLASS_ALIASES = {
    "Flaky_Mixed": "FLAKY_MIXED",
    "PointLike": "POINTLIKE",
}
DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:3000,http://localhost:3000,https://cvclinics.online"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]
DISCLAIMER = "AI-assisted slit-lamp corneal ulcer pattern screening result. Requires doctor review and clinical correlation."
INVALID_IMAGE_DISCLAIMER = "Please upload a slit-lamp corneal surface image for corneal ulcer pattern screening."

app = FastAPI(title="AFIO Corneal Ulcer AI Backend", version=MODEL_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
model_error: str | None = None
AI_GATEWAY_SHARED_SECRET = os.getenv("AI_GATEWAY_SHARED_SECRET", "")


def get_model():
    global model, model_error
    if model is not None:
        return model
    if not MODEL_PATH.exists():
        model_error = f"Missing model file: {MODEL_PATH}"
        return None
    try:
        model = load_model(MODEL_PATH, compile=False)
        model_error = None
        return model
    except Exception as exc:
        model_error = str(exc)
        return None


async def verify_ai_gateway_signature(request: Request, file: UploadFile) -> None:
    timestamp = request.headers.get("X-AFIO-Timestamp")
    signature = request.headers.get("X-AFIO-Signature")

    if not timestamp or not signature:
        raise HTTPException(status_code=401, detail="Missing AFIO signature headers.")

    try:
        timestamp_ms = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid AFIO timestamp.") from exc

    if int(time.time() * 1000) - timestamp_ms > 5 * 60 * 1000:
        raise HTTPException(status_code=403, detail="AFIO signature has expired.")

    if not AI_GATEWAY_SHARED_SECRET:
        raise HTTPException(status_code=500, detail="AI gateway shared secret is not configured.")

    file_bytes = await file.read()
    expected_signature = hmac.new(
        AI_GATEWAY_SHARED_SECRET.encode("utf-8"),
        f"{timestamp}.{base64.b64encode(file_bytes).decode('ascii')}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    await file.seek(0)

    if not hmac.compare_digest(expected_signature, signature):
        raise HTTPException(status_code=403, detail="Invalid AFIO signature.")


def read_image_bytes(image_bytes: bytes) -> Image.Image:
    try:
        return Image.open(BytesIO(image_bytes)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Invalid image file.") from exc


def apply_clahe(rgb_array: np.ndarray) -> np.ndarray:
    img = rgb_array.astype(np.uint8)
    lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    enhanced = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2RGB)
    return enhanced.astype(np.float32)


def assess_slit_lamp_quality(image: Image.Image) -> dict[str, Any]:
    small = image.resize((224, 224))
    arr = np.asarray(small).astype(np.uint8)
    gray = np.asarray(small.convert("L"))
    hsv = np.asarray(small.convert("HSV"))
    saturation = hsv[:, :, 1]
    brightness = float(gray.mean())
    contrast = float(gray.std())
    saturation_mean = float(saturation.mean())
    non_dark_ratio = float((gray > 18).mean())
    highlight_ratio = float((gray > 235).mean())
    red_green_gap = float(np.abs(arr[:, :, 0].astype(np.int16) - arr[:, :, 1].astype(np.int16)).mean())
    warnings: list[str] = []
    if contrast < 10:
        warnings.append("Image has low contrast for slit-lamp screening.")
    if brightness < 18 or brightness > 238:
        warnings.append("Image brightness is outside the expected slit-lamp range.")
    if non_dark_ratio < 0.18:
        warnings.append("Not enough visible corneal surface area detected.")
    if highlight_ratio > 0.35:
        warnings.append("Image appears overexposed.")
    if saturation_mean < 8 and red_green_gap < 5:
        warnings.append("Image has very little clinical color detail.")
    return {
        "is_valid": len(warnings) == 0,
        "warnings": warnings,
        "metrics": {
            "brightness": round(brightness, 3),
            "contrast": round(contrast, 3),
            "saturation_mean": round(saturation_mean, 3),
            "non_dark_ratio": round(non_dark_ratio, 4),
            "highlight_ratio": round(highlight_ratio, 4),
            "red_green_gap": round(red_green_gap, 3),
        },
    }


def preprocess_image(image: Image.Image) -> np.ndarray:
    resized = image.resize((224, 224))
    array = np.asarray(resized)
    array = apply_clahe(array)
    return np.expand_dims(array, axis=0)


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "AFIO Corneal Ulcer AI Backend",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "classes": CLASS_NAMES,
        "model_loaded": model is not None,
        "lazy_model_loading": model is None,
        "disclaimer": DISCLAIMER,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_path": str(MODEL_PATH),
        "error": model_error,
    }


@app.post("/predict")
async def predict(request: Request, file: UploadFile = File(...)):
    loaded_model = get_model()
    if loaded_model is None:
        raise HTTPException(status_code=503, detail=f"Corneal ulcer model is not loaded. {model_error}")
    await verify_ai_gateway_signature(request, file)
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=400, detail="Only JPG, JPEG, and PNG slit-lamp images are supported.")

    try:
        image = read_image_bytes(await file.read())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    quality = assess_slit_lamp_quality(image)
    if not quality["is_valid"]:
        return {
            "prediction": "INVALID_IMAGE",
            "confidence": 0,
            "probabilities": {},
            "risk_level": "UNKNOWN",
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "models_used": ["efficientnetv2b0"],
            "is_valid_corneal": False,
            "quality_metrics": quality["metrics"],
            "validation_warnings": quality["warnings"],
            "disclaimer": f"{INVALID_IMAGE_DISCLAIMER} {' '.join(quality['warnings'])}",
        }

    started_at = time.perf_counter()
    probabilities = loaded_model.predict(preprocess_image(image), verbose=0)[0]
    final_idx = int(np.argmax(probabilities))
    top_label = CLASS_NAMES[final_idx]
    confidence = float(probabilities[final_idx])
    normalized_probs = {
        CLASS_ALIASES[label]: round(float(probabilities[index]), 4)
        for index, label in enumerate(CLASS_NAMES)
    }
    warnings = []
    if confidence < 0.65:
        warnings.append("Low-confidence corneal ulcer pattern output. Treat as provisional and review clinically.")

    return {
        "prediction": CLASS_ALIASES[top_label],
        "confidence": round(confidence, 4),
        "probabilities": normalized_probs,
        "risk_level": "HIGH" if top_label == "PointLike" and confidence >= 0.7 else "MODERATE" if confidence < 0.7 else "LOW",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "models_used": ["efficientnetv2b0"],
        "is_valid_corneal": True,
        "quality_metrics": quality["metrics"],
        "validation_warnings": warnings,
        "disclaimer": " ".join(warnings) if warnings else DISCLAIMER,
        "inference_time_ms": round((time.perf_counter() - started_at) * 1000),
    }
