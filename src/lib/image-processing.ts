const MAX_SCAN_DIMENSION = 1200;
const MAX_PREDICTION_DIMENSION = 600;
const JPEG_QUALITY = 0.88;

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

export async function prepareScanImages(file: File) {
  const storageFile = await resizeImageFile(file, MAX_SCAN_DIMENSION);
  const predictionFile =
    storageFile.size <= 500_000 ? storageFile : await resizeImageFile(storageFile, MAX_PREDICTION_DIMENSION);

  return {
    storageFile,
    predictionFile,
    originalSize: file.size,
    storageSize: storageFile.size,
    predictionSize: predictionFile.size,
  };
}
