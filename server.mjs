import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = "myoo-final-final-finalae002.html";
let PORT = Number(process.env.PORT || 4173);
let MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_BYTES = 96 * 1024 * 1024;
const MAX_REFERENCES = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_GENERATIONS_PER_WINDOW = 5;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const rateWindows = new Map();
let activeGenerations = 0;

async function loadLocalEnv() {
  try {
    const contents = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function readBody(request) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, "The total upload is too large. Reduce the image sizes and try again.");
  }

  const chunks = [];
  let total = 0;
  let exceededLimit = false;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      exceededLimit = true;
      chunks.length = 0;
    } else if (!exceededLimit) {
      chunks.push(chunk);
    }
  }
  if (exceededLimit) {
    throw new HttpError(413, "The total upload is too large. Reduce the image sizes and try again.");
  }
  return Buffer.concat(chunks, total);
}

function imageTypeFromBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

async function parseImage(file, label) {
  if (!file || typeof file.arrayBuffer !== "function" || typeof file.name !== "string") {
    throw new HttpError(400, `${label} is missing.`);
  }
  if (!allowedImageTypes.has(file.type)) {
    throw new HttpError(415, `${label} must be a JPG, PNG, or WebP image.`);
  }
  if (!file.size || file.size > MAX_IMAGE_BYTES) {
    throw new HttpError(413, `${label} must be 10 MB or smaller.`);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const detectedType = imageTypeFromBytes(bytes);
  if (!detectedType || detectedType !== file.type) {
    throw new HttpError(400, `${label} is not a valid ${file.type.replace("image/", "").toUpperCase()} image.`);
  }
  const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "image";
  return { bytes, type: detectedType, name: safeName };
}

async function makeOpenAIRequest(product, references, productTitle, fabric, designBrief) {
  const referenceInstruction = references.length
    ? "Use each following image as a visual reference for its motifs, patterns, palette, embroidery, or styling. Blend those cues naturally into the main garment while keeping the main product recognizable. Do not turn the reference images into a collage."
    : "Keep the selected garment faithful to the main image and create a refined, photorealistic fashion product preview.";
  const prompt = [
    "Edit the first image. It is the selected MYOO garment and is the authoritative product image.",
    "Preserve its garment type, silhouette, construction, and overall identity. Apply the user's later reference images as design inspiration only, without replacing the main product.",
    referenceInstruction,
    `Garment: ${productTitle}. Selected fabric: ${fabric}.`,
    designBrief ? `Additional design direction from the customer: ${designBrief}.` : "",
    "Create one polished, photorealistic luxury fashion catalog image. Keep the garment clearly visible, coherent, and wearable. Do not add text, logos, watermarks, or extra garments."
  ].join(" ");

  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("quality", "high");
  form.append("output_format", "png");
  for (const image of [product, ...references]) {
    form.append("image[]", new Blob([image.bytes], { type: image.type }), image.name);
  }

  const upstream = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(180000)
  });
  const text = await upstream.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new HttpError(502, "The image provider returned an unreadable response. Please try again.");
  }
  if (!upstream.ok) {
    const providerMessage = result?.error?.message;
    const message = upstream.status === 401
      ? "OpenAI rejected the API key. Check that OPENAI_API_KEY in .env is a valid, active OpenAI API key."
      : typeof providerMessage === "string" ? providerMessage.slice(0, 400) : "Please try again later.";
    throw new HttpError(upstream.status === 429 ? 503 : 502, `Image generation failed: ${message}`);
  }
  const encodedImage = result?.data?.[0]?.b64_json;
  if (typeof encodedImage !== "string" || !encodedImage.length) {
    throw new HttpError(502, "The image provider did not return a generated image.");
  }
  return `data:image/png;base64,${encodedImage}`;
}

function takeGenerationSlot(address) {
  const now = Date.now();
  const previous = rateWindows.get(address);
  const entry = !previous || now - previous.startedAt >= RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : previous;
  if (entry.count >= MAX_GENERATIONS_PER_WINDOW) return false;
  entry.count++;
  rateWindows.set(address, entry);

  if (rateWindows.size > 1000) {
    for (const [key, value] of rateWindows) {
      if (now - value.startedAt >= RATE_WINDOW_MS) rateWindows.delete(key);
    }
  }
  return true;
}

async function handleSynthesis(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { error: "AI generation is not configured. Add OPENAI_API_KEY to the server's .env file." });
    return;
  }

  const address = request.socket.remoteAddress || "unknown";
  if (!takeGenerationSlot(address)) {
    sendJson(response, 429, { error: "Too many image generations from this connection. Try again in a few minutes." });
    return;
  }
  if (activeGenerations >= 2) {
    sendJson(response, 503, { error: "The image service is busy. Please try again shortly." });
    return;
  }

  activeGenerations++;
  try {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new HttpError(415, "Send product and reference images as multipart form data.");
    }
    const body = await readBody(request);
    const parsedRequest = new Request("http://localhost/api/synthesize", {
      method: "POST",
      headers: { "content-type": contentType },
      body
    });
    const form = await parsedRequest.formData();
    const referenceFiles = form.getAll("references");
    if (referenceFiles.length > MAX_REFERENCES) {
      throw new HttpError(400, `Upload no more than ${MAX_REFERENCES} reference images.`);
    }

    const product = await parseImage(form.get("productImage"), "The selected product image");
    const references = [];
    for (let index = 0; index < referenceFiles.length; index++) {
      references.push(await parseImage(referenceFiles[index], `Reference image ${index + 1}`));
    }
    const productTitle = String(form.get("productTitle") || "Custom outfit").slice(0, 160);
    const fabric = String(form.get("fabric") || "Selected fabric").slice(0, 80);
    const designBrief = String(form.get("designBrief") || "").slice(0, 1000);
    const image = await makeOpenAIRequest(product, references, productTitle, fabric, designBrief);
    sendJson(response, 200, { image, model: MODEL });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error("Image generation request failed:", error?.message || "Unexpected server error");
    }
    const status = error instanceof HttpError ? error.status : 502;
    const message = error instanceof HttpError
      ? error.message
      : "The image service could not complete the request. Check the server log and try again.";
    if (!response.headersSent) sendJson(response, status, { error: message });
  } finally {
    activeGenerations--;
  }
}

function contentTypeFor(filePath) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  })[path.extname(filePath).toLowerCase()];
}

async function handleStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }
  if (requestedPath === "/") requestedPath = `/${PAGE}`;
  if (requestedPath.split(/[\\/]/).some(segment => segment.startsWith("."))) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || !contentTypeFor(filePath)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": fileInfo.size,
      "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") response.end();
    else response.end(await readFile(filePath));
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

await loadLocalEnv();
PORT = Number(process.env.PORT || PORT);
MODEL = process.env.OPENAI_IMAGE_MODEL || MODEL;
const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    sendJson(response, 400, { error: "Invalid request URL." });
    return;
  }

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { configured: Boolean(process.env.OPENAI_API_KEY), model: MODEL });
    return;
  }
  if (pathname === "/api/synthesize" && request.method === "POST") {
    await handleSynthesis(request, response);
    return;
  }
  await handleStatic(request, response, pathname);
});

server.listen(PORT, () => {
  console.log(`MYOO AI server listening at http://localhost:${PORT}`);
});
