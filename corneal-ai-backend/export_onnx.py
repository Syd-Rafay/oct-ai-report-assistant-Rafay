from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
from torchvision import models


CHECKPOINT_DIR = Path("checkpoints")
ONNX_DIR = Path("onnx")


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
    "resnet50": (build_resnet50, "binary_resnet50.pt", "binary_resnet50.onnx"),
    "densenet121": (build_densenet121, "binary_densenet121.pt", "binary_densenet121.onnx"),
    "efficientnetv2": (build_efficientnetv2, "binary_efficientnetv2.pt", "binary_efficientnetv2.onnx"),
}


def clean_state_dict(checkpoint: Any) -> dict[str, torch.Tensor]:
    if isinstance(checkpoint, dict) and isinstance(checkpoint.get("model_state_dict"), dict):
        checkpoint = checkpoint["model_state_dict"]
    if not isinstance(checkpoint, dict):
        raise RuntimeError("Unsupported checkpoint format.")
    return {key.removeprefix("module."): value for key, value in checkpoint.items()}


def export_model(name: str) -> None:
    builder, checkpoint_name, onnx_name = MODEL_FILES[name]
    checkpoint_path = CHECKPOINT_DIR / checkpoint_name
    output_path = ONNX_DIR / onnx_name
    output_path.parent.mkdir(parents=True, exist_ok=True)

    model = builder()
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    model.load_state_dict(clean_state_dict(checkpoint), strict=True)
    model.eval()

    dummy = torch.randn(1, 3, 224, 224)
    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    print(f"Exported {name} -> {output_path}")


def main() -> None:
    for name in MODEL_FILES:
        export_model(name)


if __name__ == "__main__":
    main()
