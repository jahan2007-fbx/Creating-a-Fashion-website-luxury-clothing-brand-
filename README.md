# MYOO

MYOO is a static fashion prototype with a server-side OpenAI image-editing feature.

## Local
1. Install Node.js 20+.
2. Put an active OpenAI API key in `.env` as `OPENAI_API_KEY=...`.
3. Run `npm start`.
4. Open `http://localhost:4173`.

## Vercel
Import this folder as a Vercel project and add `OPENAI_API_KEY` in Project Settings → Environment Variables for Production. Optionally add `OPENAI_IMAGE_MODEL=gpt-image-1`. Do not upload `.env`. The `/api/health` and `/api/synthesize` serverless functions keep the API key on the server.

The frontend compresses product/reference images before sending them to the serverless function. The project includes corrected JPEG product assets because several original files were actually WebP/AVIF data saved with `.jpg` filenames, which caused the original server to reject them as invalid JPEGs.
