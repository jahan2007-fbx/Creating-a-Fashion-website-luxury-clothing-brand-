const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCES = 4;
const MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function decodeDataUrl(value, label) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) throw new Error(`${label} is missing or invalid.`);
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error(`${label} must be a JPEG, PNG, or WebP image.`);
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`${label} must be smaller than 8 MB.`);
  return { type: match[1], bytes };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed.");
  if (!process.env.OPENAI_API_KEY) return fail(res, 503, "AI generation is not configured. Add OPENAI_API_KEY to the deployment environment variables.");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const product = decodeDataUrl(body.productImage, "The selected product image");
    const references = Array.isArray(body.references) ? body.references.slice(0, MAX_REFERENCES).map((x, i) => decodeDataUrl(x, `Reference image ${i + 1}`)) : [];
    const productTitle = String(body.productTitle || "Custom outfit").slice(0, 160);
    const fabric = String(body.fabric || "Selected fabric").slice(0, 80);
    const designBrief = String(body.designBrief || "").slice(0, 1200);

    const referenceInstruction = references.length
      ? "Use each following image as visual reference for motifs, patterns, palette, embroidery, or styling. Blend those cues naturally into the main garment while keeping the main product recognizable. Do not make a collage."
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
    form.append("image[]", new Blob([product.bytes], { type: product.type }), "product.jpg");
    references.forEach((image, i) => form.append("image[]", new Blob([image.bytes], { type: image.type }), `reference-${i + 1}.jpg`));

    const upstream = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(180000)
    });
    const text = await upstream.text();
    let result = {};
    try { result = JSON.parse(text); } catch { }
    if (!upstream.ok) {
      const providerMessage = result?.error?.message;
      const message = upstream.status === 401
        ? "OpenAI rejected the API key. Check the deployment's OPENAI_API_KEY."
        : typeof providerMessage === "string" ? providerMessage.slice(0, 400) : "The image provider rejected the request.";
      return fail(res, upstream.status === 429 ? 503 : 502, `Image generation failed: ${message}`);
    }
    const encodedImage = result?.data?.[0]?.b64_json;
    if (typeof encodedImage !== "string" || !encodedImage.length) return fail(res, 502, "The image provider did not return a generated image.");
    return res.status(200).json({ image: `data:image/png;base64,${encodedImage}`, model: MODEL });
  } catch (error) {
    console.error("MYOO synthesis error", error);
    return fail(res, 502, error?.message || "The image service could not complete the request.");
  }
}
