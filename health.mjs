export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1" });
}
