const MAX_SCAN_DIMENSION = 1200;
const MAX_PREDICTION_DIMENSION = 600;
const JPEG_QUALITY = 0.88;

export type ImageQualityAssessment = {
  width: number;
  height: number;
  brightness: number;
  contrast: number;
  edgeScore: number;
  warnings: string[];
};

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = JPEG_QUALITY): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not prepare the image for upload."));
      },
      type,
      quality
    );
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the selected image."));
    };
    image.src = url;
  });
}

function scaleToFit(width: number, height: number, maxDimension: number) {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const ratio = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export async function resizeImageFile(file: File, maxDimension = MAX_SCAN_DIMENSION): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  const image = await loadImage(file);
  const target = scaleToFit(image.naturalWidth, image.naturalHeight, maxDimension);

  if (target.width === image.naturalWidth && target.height === image.naturalHeight && file.size < 900_000) {
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the image for upload.");

  context.drawImage(image, 0, 0, target.width, target.height);
  const blob = await canvasToBlob(canvas);
  return new File([blob], file.name.replace(/\.(png|jpg|jpeg)$/i, "") + ".jpg", {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

async function assessImageQuality(file: File): Promise<ImageQualityAssessment> {
  const image = await loadImage(file);
  const target = scaleToFit(image.naturalWidth, image.naturalHeight, 180);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not inspect image quality.");

  context.drawImage(image, 0, 0, target.width, target.height);
  const pixels = context.getImageData(0, 0, target.width, target.height).data;
  const grays = new Float32Array(target.width * target.height);
  let sum = 0;
  for (let i = 0; i < grays.length; i++) {
    const offset = i * 4;
    const gray = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / (3 * 255);
    grays[i] = gray;
    sum += gray;
  }
  const brightness = sum / grays.length;
  let variance = 0;
  for (let i = 0; i < grays.length; i++) variance += (grays[i] - brightness) ** 2;
  const contrast = Math.sqrt(variance / grays.length);

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < target.height - 1; y++) {
    for (let x = 1; x < target.width - 1; x++) {
      const index = y * target.width + x;
      const gx = Math.abs(grays[index + 1] - grays[index - 1]);
      const gy = Math.abs(grays[index + target.width] - grays[index - target.width]);
      edgeSum += gx + gy;
      edgeCount++;
    }
  }
  const edgeScore = edgeCount ? edgeSum / edgeCount : 0;
  const warnings = [
    image.naturalWidth < 224 || image.naturalHeight < 224 ? "Image resolution is low for AI screening." : "",
    brightness < 0.08 ? "Image appears very dark or blank." : "",
    brightness > 0.92 ? "Image appears overexposed or mostly blank." : "",
    contrast < 0.035 ? "Image contrast is very low; result may be unreliable." : "",
    edgeScore < 0.012 ? "Image has very little retinal detail; verify this is a valid fundus image." : "",
  ].filter(Boolean);

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    brightness: Number(brightness.toFixed(4)),
    contrast: Number(contrast.toFixed(4)),
    edgeScore: Number(edgeScore.toFixed(4)),
    warnings,
  };
}

export async function prepareScanImages(file: File) {
  const storageFile = await resizeImageFile(file, MAX_SCAN_DIMENSION);
  const predictionFile =
    storageFile.size <= 500_000 ? storageFile : await resizeImageFile(storageFile, MAX_PREDICTION_DIMENSION);
  const quality = await assessImageQuality(predictionFile);

  return {
    storageFile,
    predictionFile,
    originalSize: file.size,
    storageSize: storageFile.size,
    predictionSize: predictionFile.size,
    quality,
  };
}
