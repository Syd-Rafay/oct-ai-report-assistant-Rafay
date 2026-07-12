import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from model import (
    DISCLAIMER,
    INVALID_IMAGE_DISCLAIMER,
    MODEL_NAME,
    MODEL_VERSION,
    assess_vkg_image_quality,
    load_models,
    load_summary,
    predict_image,
    read_image_bytes,
)
from schemas import CornealPrediction


DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:3000,http://localhost:3000,https://cvclinics.online"
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(",")
    if origin.strip()
]

app = FastAPI(title="AFIO Corneal AI Backend", version=MODEL_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

models_dict = None
model_error = None
summary = load_summary()


def get_models():
    global models_dict, model_error
    if models_dict is None:
        models_dict, model_error = load_models()
    return models_dict, model_error


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "AFIO Corneal AI Backend",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "models_loaded": list(models_dict.keys()) if models_dict else [],
        "lazy_model_loading": models_dict is None,
        "summary": summary,
        "disclaimer": DISCLAIMER,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": bool(models_dict),
        "models_loaded": list(models_dict.keys()) if models_dict else [],
        "error": model_error,
        "summary": summary,
    }


@app.post("/predict", response_model=CornealPrediction)
async def predict(file: UploadFile = File(...)):
    loaded_models, load_error = get_models()
    if not loaded_models:
        raise HTTPException(status_code=503, detail=f"Corneal model is not loaded. {load_error}")
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=400, detail="Only JPG, JPEG, and PNG corneal images are supported.")

    try:
        image = read_image_bytes(await file.read())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    quality = assess_vkg_image_quality(image)
    if not quality["is_valid"]:
        return CornealPrediction(
            prediction="INVALID_IMAGE",
            confidence=0,
            probabilities={},
            risk_level="UNKNOWN",
            model_name=MODEL_NAME,
            model_version=MODEL_VERSION,
            models_used=list(loaded_models.keys()),
            is_valid_corneal=False,
            quality_metrics=quality["metrics"],
            validation_warnings=quality["warnings"],
            disclaimer=f"{INVALID_IMAGE_DISCLAIMER} {' '.join(quality['warnings'])}",
        )

    return CornealPrediction(**predict_image(image, loaded_models, quality))
