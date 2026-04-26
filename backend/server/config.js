import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 8787),
  providerApiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "",
  providerBaseUrl:
    process.env.OPENROUTER_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://openrouter.ai/api/v1",
  openaiModel: process.env.OPENAI_MODEL || "openai/gpt-4o-mini",
  imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
  appOrigin: process.env.APP_ORIGIN || "http://localhost:5173",
  appUrl: process.env.APP_URL || "http://localhost:5173",
  appName: process.env.APP_NAME || "Zentrix",
  webSearchMaxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS || 5)
};

