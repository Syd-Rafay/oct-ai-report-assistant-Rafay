from pydantic import BaseModel


class CornealPrediction(BaseModel):
    prediction: str
    confidence: float
    probabilities: dict[str, float]
    risk_level: str
    model_name: str
    model_version: str
    models_used: list[str]
    is_valid_corneal: bool
    disclaimer: str
    inference_time_ms: int | None = None
