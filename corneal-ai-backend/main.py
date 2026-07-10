import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from model import (
    DISCLAIMER,
    INVALID_IMAGE_DISCLAIMER,
    MODEL_NAME,
    MODEL_VERSION,
    basic_corneal_image_check,
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

models_dict, model_error = load_models()
summary = load_summary()


@app.get("/")
def root():
    return {
        "status": "ok",
        "service": "AFIO Corneal AI Backend",
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "models_loaded": list(models_dict.keys()),
        "summary": summary,
        "disclaimer": DISCLAIMER,
    }


@app.get("/health")
def health():
    return {
        "status": "ok" if models_dict else "model_error",
        "model_loaded": bool(models_dict),
        "models_loaded": list(models_dict.keys()),
        "error": model_error,
        "summary": summary,
    }


@app.post("/predict", response_model=CornealPrediction)
async def predict(file: UploadFile = File(...)):
    if not models_dict:
        raise HTTPException(status_code=503, detail=f"Corneal model is not loaded. {model_error}")
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=400, detail="Only JPG, JPEG, and PNG corneal images are supported.")

    try:
        image = read_image_bytes(await file.read())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not basic_corneal_image_check(image):
        return CornealPrediction(
            prediction="INVALID_IMAGE",
            confidence=0,
            probabilities={},
            risk_level="UNKNOWN",
            model_name=MODEL_NAME,
            model_version=MODEL_VERSION,
            models_used=list(models_dict.keys()),
            is_valid_corneal=False,
            disclaimer=INVALID_IMAGE_DISCLAIMER,
        )

    return CornealPrediction(**predict_image(image, models_dict))
