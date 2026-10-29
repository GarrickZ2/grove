// Composer attachments shared by TaskChat and Orbit's New page: one place
// decides how a picked/pasted/dropped File becomes a prompt attachment.

export interface Attachment {
  type: "image" | "audio" | "resource";
  data: string; // base64 for image/audio
  mimeType: string;
  name: string; // original filename
  label: string; // display label e.g. "Image #1", "Audio #2", "File #3"
  previewUrl?: string; // blob URL for image preview
  uri?: string;
  size?: number;
  /** Raw file pending upload — upload is deferred until the prompt is sent */
  pendingFile?: File;
}

export function attachmentLabel(type: Attachment["type"], index: number): string {
  const prefix = type === "image" ? "Image" : type === "audio" ? "Audio" : "File";
  return `${prefix} #${index}`;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — Claude API limit
const MAX_IMAGE_DIMENSION = 2048;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Resize + compress an image blob to JPEG via Canvas. Reduces dimensions first,
 *  then lowers JPEG quality in steps until the result fits within MAX_IMAGE_BYTES. */
async function compressImageViaCanvas(source: File | Blob): Promise<Blob> {
  const objectUrl = URL.createObjectURL(source);
  const img = new Image();
  img.src = objectUrl;
  await img.decode();
  URL.revokeObjectURL(objectUrl);

  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
    const ratio = Math.min(MAX_IMAGE_DIMENSION / w, MAX_IMAGE_DIMENSION / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);

  let quality = 0.85;
  let blob: Blob | null = null;
  while (quality >= 0.3) {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (!blob || blob.size <= MAX_IMAGE_BYTES) break;
    quality -= 0.1;
  }
  if (!blob) throw new Error("Canvas compression failed");
  return blob;
}

/** A file that can't be attached, with a message meant for the user. */
export class AttachmentError extends Error {}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.onabort = () => reject(new Error("Read aborted"));
    reader.readAsDataURL(blob);
  });
}

const jpegName = (name: string) => name.replace(/\.[^.]+$/, ".jpg");

async function compressedImage(file: File, failure: string): Promise<Omit<Attachment, "label">> {
  let blob: Blob;
  try {
    blob = await compressImageViaCanvas(file);
  } catch {
    throw new AttachmentError(failure);
  }
  return { type: "image", data: await readAsBase64(blob), mimeType: "image/jpeg", name: jpegName(file.name), previewUrl: URL.createObjectURL(blob) };
}

/**
 * Turn a File into an attachment (the caller assigns the label). Images are
 * inlined as base64 — compressed or converted to JPEG when too large, too big
 * in pixels, or in an unsupported format; audio is inlined; anything else is
 * kept as a File and uploaded when the prompt is sent. Throws AttachmentError
 * (user-facing message) for files that can't be attached.
 */
export async function prepareFileAttachment(file: File): Promise<Omit<Attachment, "label">> {
  if (!file.type.startsWith("image/") && !file.type.startsWith("audio/")) {
    return { type: "resource", data: "", mimeType: file.type || "application/octet-stream", name: file.name, size: file.size, pendingFile: file };
  }
  if (file.type.startsWith("audio/")) {
    return { type: "audio", data: await readAsBase64(file), mimeType: file.type, name: file.name };
  }
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    return compressedImage(file, `Unsupported image format (${file.name}). Please convert to JPEG or PNG and try again.`);
  }
  // GIF: never re-encode via Canvas (would lose animation)
  if (file.type === "image/gif" && file.size > MAX_IMAGE_BYTES) {
    throw new AttachmentError(`GIF file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please compress and try again.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return compressedImage(file, `Failed to compress image (${file.name}). Please compress manually and try again.`);
  }
  // Check dimensions even for small files — Claude enforces a 2000px limit in multi-image requests
  const dimCheckUrl = URL.createObjectURL(file);
  const dimImg = new Image();
  dimImg.src = dimCheckUrl;
  await dimImg.decode().catch(() => {});
  URL.revokeObjectURL(dimCheckUrl);
  if (dimImg.naturalWidth > MAX_IMAGE_DIMENSION || dimImg.naturalHeight > MAX_IMAGE_DIMENSION) {
    return compressedImage(file, `Image is too large and resizing failed (${file.name}). Please resize it manually and try again.`);
  }
  return { type: "image", data: await readAsBase64(file), mimeType: file.type, name: file.name, previewUrl: URL.createObjectURL(file) };
}
