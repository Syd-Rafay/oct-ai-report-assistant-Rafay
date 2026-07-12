import json
import os
import time
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, UnidentifiedImageError
from torchvision import models, transforms


CHECKPOINT_DIR = Path(os.getenv("CORNEAL_CHECKPOINT_DIR", "checkpoints"))
MODEL_NAME = "Group 2 Binary Corneal Ensemble"
MODEL_VERSION = "binary-ensemble-v1"
DISCLAIMER = "AI-assisted corneal keratoconus screening result. Requires doctor review."
INVALID_IMAGE_DISCLAIMER = "Please upload a corneal topography/VKG-style image for this screening model."
LOW_CONFIDENCE_DISCLAIMER = "The uploaded image resembles VKG/topography, but the AI confidence is low. Ask a doctor to review and consider repeating the scan."
CLASS_NAMES = ["non_keratoconus", "keratoconus"]

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))

preprocess = transforms.Compose(
    [
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ]
)


def build_resnet50() -> nn.Module:
    model = models.resnet50(weights=None)
    in_features = model.fc.in_features
    model.fc = nn.Sequential(
        nn.BatchNorm1d(in_features),
        nn.Dropout(0.4),
        nn.Linear(in_features, 256),
        nn.ReLU(),
        nn.Dropout(0.3),
        nn.Linear(256, 2),
    )
    return model


def build_densenet121() -> nn.Module:
    model = models.densenet121(weights=None)
    in_features = model.classifier.in_features
    model.classifier = nn.Sequential(
        nn.BatchNorm1d(in_features),
        nn.Dropout(0.4),
        nn.Linear(in_features, 256),
        nn.ReLU(),
        nn.Dropout(0.3),
        nn.Linear(256, 2),
    )
    return model


def build_efficientnetv2() -> nn.Module:
    model = models.efficientnet_v2_s(weights=None)
    in_features = model.classifier[1].in_features
    model.classifier = nn.Sequential(
        nn.BatchNorm1d(in_features),
        nn.Dropout(0.4),
        nn.Linear(in_features, 512),
        nn.SiLU(),
        nn.BatchNorm1d(512),
        nn.Dropout(0.3),
        nn.Linear(512, 2),
    )
    return model


MODEL_FILES = {
    "resnet50": (build_resnet50, "binary_resnet50.pt"),
    "densenet121": (build_densenet121, "binary_densenet121.pt"),
    "efficientnetv2": (build_efficientnetv2, "binary_efficientnetv2.pt"),
}


def selected_model_files() -> dict[str, tuple[Any, str]]:
    selected = [
        name.strip()
        for name in os.getenv("CORNEAL_MODELS", "resnet50,densenet121,efficientnetv2").split(",")
        if name.strip()
    ]
    if not selected:
        selected = list(MODEL_FILES)
    return {name: MODEL_FILES[name] for name in selected if name in MODEL_FILES}


def clean_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    if isinstance(checkpoint, dict) and isinstance(checkpoint.get("model_state_dict"), dict):
        checkpoint = checkpoint["model_state_dict"]
    if not isinstance(checkpoint, dict):
        raise RuntimeError("Unsupported checkpoint format.")
    return {key.removeprefix("module."): value for key, value in checkpoint.items()}


def load_models() -> tuple[dict[str, nn.Module], str | None]:
    loaded: dict[str, nn.Module] = {}
    errors: list[str] = []
    for name, (builder, filename) in selected_model_files().items():
        path = CHECKPOINT_DIR / filename
        if not path.exists():
            errors.append(f"{name}: missing {path}")
            continue
        try:
            checkpoint = torch.load(path, map_location=DEVICE)
            model = builder()
            model.load_state_dict(clean_state_dict(checkpoint), strict=True)
            model.to(DEVICE)
            model.eval()
            loaded[name] = model
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    return loaded, "; ".join(errors) if errors else None


def load_summary() -> dict[str, Any]:
    path = CHECKPOINT_DIR / "binary_ensemble_summary.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def read_image_bytes(image_bytes: bytes) -> Image.Image:
    try:
        return Image.open(BytesIO(image_bytes)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Invalid image file.") from exc


def assess_vkg_image_quality(image: Image.Image) -> dict[str, Any]:
    small = image.convert("RGB").resize((224, 224))
    arr = np.array(small)
    gray = np.array(small.convert("L"))
    hsv = np.array(small.convert("HSV"))
    saturation = hsv[:, :, 1]
    contrast = float(gray.std())
    saturation_mean = float(saturation.mean())
    brightness = float(gray.mean())
    color_spread = float(np.std(arr.reshape(-1, 3).mean(axis=1)))
    colored_mask = (saturation > 45) & (gray > 20) & (gray < 245)
    colored_ratio = float(colored_mask.mean())

    ys, xs = np.where(colored_mask)
    circle_score = 0.0
    center_score = 0.0
    fill_score = 0.0
    if len(xs) > 250:
        width = float(xs.max() - xs.min() + 1)
        height = float(ys.max() - ys.min() + 1)
        aspect_ratio = min(width, height) / max(width, height)
        center_x = float(xs.mean()) / 223.0
        center_y = float(ys.mean()) / 223.0
        center_distance = ((center_x - 0.5) ** 2 + (center_y - 0.5) ** 2) ** 0.5
        fill_score = len(xs) / max(width * height, 1.0)
        circle_score = max(0.0, min(1.0, aspect_ratio))
        center_score = max(0.0, 1.0 - center_distance * 3.0)

    warnings: list[str] = []
    if contrast < 12:
        warnings.append("Image has very low contrast.")
    if brightness < 8 or brightness > 247:
        warnings.append("Image brightness is outside the expected clinical-map range.")
    if saturation_mean < 18 or color_spread < 18:
        warnings.append("Image is not colorful enough for a VKG/topography map.")
    if colored_ratio < 0.08:
        warnings.append("Not enough colored topography-map area detected.")
    if circle_score < 0.62:
        warnings.append("Colored map area does not look sufficiently circular.")
    if center_score < 0.35:
        warnings.append("Topography map is not centered enough.")
    if fill_score < 0.22:
        warnings.append("Detected map area is too sparse for a VKG/topography scan.")

    is_valid = not warnings
    return {
        "is_valid": is_valid,
        "warnings": warnings,
        "metrics": {
            "contrast": round(contrast, 3),
            "brightness": round(brightness, 3),
            "saturation_mean": round(saturation_mean, 3),
            "color_spread": round(color_spread, 3),
            "colored_ratio": round(colored_ratio, 4),
            "circle_score": round(circle_score, 4),
            "center_score": round(center_score, 4),
            "fill_score": round(fill_score, 4),
        },
    }


def basic_corneal_image_check(image: Image.Image) -> bool:
    return bool(assess_vkg_image_quality(image)["is_valid"])


def low_confidence_warning(confidence: float, keratoconus_probability: float) -> str | None:
    if confidence < 0.65:
        return LOW_CONFIDENCE_DISCLAIMER
    if 0.35 <= keratoconus_probability <= 0.65:
        return "Borderline keratoconus probability. Treat as suspect and review clinically."
    return None

def predict_image(image: Image.Image, models_dict: dict[str, nn.Module], quality: dict[str, Any] | None = None) -> dict[str, Any]:
    started_at = time.perf_counter()
    tensor = preprocess(image).unsqueeze(0).to(DEVICE)
    probabilities_by_model = []
    with torch.inference_mode():
        for model in models_dict.values():
            probabilities_by_model.append(F.softmax(model(tensor), dim=1)[0].cpu().numpy())

    averaged = np.stack(probabilities_by_model, axis=0).mean(axis=0)
    non_kc = round(float(averaged[0]), 4)
    kc = round(float(averaged[1]), 4)
    prediction = "KERATOCONUS_RISK" if kc >= 0.5 else "NO_KERATOCONUS_RISK"
    confidence = kc if prediction == "KERATOCONUS_RISK" else non_kc
    risk_level = "HIGH" if kc >= 0.7 else "MODERATE" if kc >= 0.4 else "LOW"
    warning = low_confidence_warning(float(confidence), kc)
    validation_warnings = [warning] if warning else []

    return {
        "prediction": "INVALID_OR_UNCERTAIN_IMAGE" if warning and confidence < 0.65 else prediction,
        "confidence": round(float(confidence), 4),
        "probabilities": {
            "non_keratoconus": non_kc,
            "keratoconus": kc,
        },
        "risk_level": risk_level,
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "models_used": list(models_dict.keys()),
        "is_valid_corneal": not (warning and confidence < 0.65),
        "quality_metrics": (quality or {}).get("metrics", {}),
        "validation_warnings": validation_warnings,
        "disclaimer": warning or DISCLAIMER,
        "inference_time_ms": round((time.perf_counter() - started_at) * 1000),
    }
