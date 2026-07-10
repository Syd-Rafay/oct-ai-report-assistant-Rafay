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


def clean_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    if isinstance(checkpoint, dict) and isinstance(checkpoint.get("model_state_dict"), dict):
        checkpoint = checkpoint["model_state_dict"]
    if not isinstance(checkpoint, dict):
        raise RuntimeError("Unsupported checkpoint format.")
    return {key.removeprefix("module."): value for key, value in checkpoint.items()}


def load_models() -> tuple[dict[str, nn.Module], str | None]:
    loaded: dict[str, nn.Module] = {}
    errors: list[str] = []
    for name, (builder, filename) in MODEL_FILES.items():
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


def basic_corneal_image_check(image: Image.Image) -> bool:
    small = image.convert("RGB").resize((224, 224))
    arr = np.array(small)
    gray = np.array(small.convert("L"))
    saturation = np.array(small.convert("HSV"))[:, :, 1]
    contrast = float(gray.std())
    saturation_mean = float(saturation.mean())
    brightness = float(gray.mean())
    color_spread = float(np.std(arr.reshape(-1, 3).mean(axis=1)))

    if contrast < 12 or brightness < 8 or brightness > 247:
        return False
    # Topography maps are usually colorful heat maps or annotated clinical maps.
    if saturation_mean < 12 and color_spread < 18:
        return False
    return True


def predict_image(image: Image.Image, models_dict: dict[str, nn.Module]) -> dict[str, Any]:
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

    return {
        "prediction": prediction,
        "confidence": round(float(confidence), 4),
        "probabilities": {
            "non_keratoconus": non_kc,
            "keratoconus": kc,
        },
        "risk_level": risk_level,
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "models_used": list(models_dict.keys()),
        "is_valid_corneal": True,
        "disclaimer": DISCLAIMER,
        "inference_time_ms": round((time.perf_counter() - started_at) * 1000),
    }
