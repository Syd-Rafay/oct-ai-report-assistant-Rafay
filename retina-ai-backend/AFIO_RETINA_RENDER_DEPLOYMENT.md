# AFIO Retina Backend Render Deployment

Date: 2026-07-12

## Render Service

```text
afio-retina-ai-backend
```

## Endpoints

```text
GET  /health
POST /predict
POST /predict-glaucoma
POST /predict-hr
```

All prediction endpoints expect multipart form-data field:

```text
image
```

## Model Handling

The model files are not committed to GitHub. They are downloaded during the Render build from:

```text
https://drive.google.com/drive/folders/1VBxwdx-CoSBP906N3Zx_gEjRGfeQtglo
```

Required files:

```text
best_efficientnet_model.pth
glaucoma_model.onnx
glaucoma_model.onnx.data
hr_efficientnet_model.onnx
smoke_test.onnx
smoke_test.onnx.data
```

## First Deployment Mode

The service currently uses:

```text
SKIP_GRADCAM=true
```

This keeps the core screening APIs deployable without installing the heavier Python/Torch Grad-CAM service. Grad-CAM can be enabled later after adding the Python runtime/dependencies strategy.

## Frontend Hook

After Render creates the service, set this Vercel environment variable:

```text
NEXT_PUBLIC_RETINA_BACKEND_URL=https://<render-retina-service-url>
```

Then redeploy the Vercel frontend.
