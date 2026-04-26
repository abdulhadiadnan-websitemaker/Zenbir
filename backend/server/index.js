import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { config } from "./config.js";
import { openai, SYSTEM_PROMPT } from "./openaiClient.js";
import { validateChatPayload } from "./validate.js";

const app = express();

function shouldTriggerImageGeneration(input) {
  const text = String(input || "").trim().toLowerCase();
  return text.startsWith("/image ") || /(^|\s)(generate|create|make)\s+(an?\s+)?image\b/.test(text);
}

function shouldTriggerWebSearch(input) {
  const text = String(input || "").trim().toLowerCase();
  return text.startsWith("/search ") || text.includes("search web") || text.includes("search the web");
}

function getImagePrompt(input) {
  const raw = String(input || "").trim();
  if (raw.toLowerCase().startsWith("/image ")) {
    return raw.slice(7).trim();
  }
  return raw
    .replace(/(^|\s)(generate|create|make)\s+(an?\s+)?image\s*(of)?/i, " ")
    .trim();
}

function getSearchQuery(input) {
  const raw = String(input || "").trim();
  if (raw.toLowerCase().startsWith("/search ")) {
    return raw.slice(8).trim();
  }
  return raw
    .replace(/search( the)? web( for)?/i, " ")
    .trim();
}

async function runWebSearch(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    no_html: "1",
    no_redirect: "1"
  });
  const response = await fetch(`https://api.duckduckgo.com/?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Web search failed with ${response.status}`);
  }
  const data = await response.json();
  const direct = [];
  if (data.AbstractText && data.AbstractURL) {
    direct.push({
      title: data.Heading || "Top result",
      snippet: data.AbstractText,
      url: data.AbstractURL
    });
  }
  const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of related) {
    if (topic?.Text && topic?.FirstURL) {
      direct.push({ title: topic.Text.split(" - ")[0], snippet: topic.Text, url: topic.FirstURL });
      continue;
    }
    if (Array.isArray(topic?.Topics)) {
      for (const nested of topic.Topics) {
        if (nested?.Text && nested?.FirstURL) {
          direct.push({
            title: nested.Text.split(" - ")[0],
            snippet: nested.Text,
            url: nested.FirstURL
          });
        }
      }
    }
  }
  return direct.slice(0, Math.max(1, config.webSearchMaxResults || 5));
}

app.use(helmet());
app.use(
  cors({
    origin: config.appOrigin
  })
);
app.use(express.json({ limit: "1mb" }));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again." }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat", chatLimiter, async (req, res) => {
  // #region agent log
  fetch("http://127.0.0.1:7455/ingest/e1268678-7cd2-402b-92e5-e6fe5159353d", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "de0085" },
    body: JSON.stringify({
      sessionId: "de0085",
      runId: "pre-fix",
      hypothesisId: "H17",
      location: "backend/server/index.js:32",
      message: "Backend /api/chat entry",
      data: {
        hasApiKey: Boolean(config.providerApiKey),
        model: config.openaiModel,
        bodyKeys: req.body ? Object.keys(req.body) : []
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  if (!config.providerApiKey) {
    return res.status(500).json({
      error: "Server is missing OPENROUTER_API_KEY (or OPENAI_API_KEY)."
    });
  }

  const error = validateChatPayload(req.body);
  if (error) {
    // #region agent log
    fetch("http://127.0.0.1:7455/ingest/e1268678-7cd2-402b-92e5-e6fe5159353d", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "de0085" },
      body: JSON.stringify({
        sessionId: "de0085",
        runId: "pre-fix",
        hypothesisId: "H17",
        location: "backend/server/index.js:44",
        message: "Payload validation failed",
        data: { error },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    return res.status(400).json({ error });
  }

  const { message, history = [] } = req.body;
  const userMessage = message.trim();
  if (shouldTriggerImageGeneration(userMessage)) {
    const imagePrompt = getImagePrompt(userMessage);
    if (!imagePrompt) {
      return res.status(400).json({
        error: "Please provide an image prompt after /image."
      });
    }
    try {
      const generated = await openai.images.generate({
        model: config.imageModel,
        prompt: imagePrompt,
        size: "1024x1024"
      });
      const imageUrl = generated?.data?.[0]?.url;
      if (!imageUrl) {
        return res.status(502).json({ error: "Image generation did not return a URL." });
      }
      const reply = `I generated an image for: **${imagePrompt}**\n\n![Generated image](${imageUrl})\n\n[Open image in new tab](${imageUrl})`;
      return res.json({ reply });
    } catch (imageError) {
      return res.status(500).json({
        error: `Image generation failed. ${String(imageError?.message || "Try again with a simpler prompt.")}`
      });
    }
  }

  if (shouldTriggerWebSearch(userMessage)) {
    const query = getSearchQuery(userMessage);
    if (!query) {
      return res.status(400).json({
        error: "Please provide a search query after /search."
      });
    }
    try {
      const results = await runWebSearch(query);
      if (!results.length) {
        return res.json({
          reply: `I searched the web for **${query}**, but I could not find useful results right now.`
        });
      }
      const formatted = results
        .map((item, index) => `${index + 1}. [${item.title}](${item.url})\n   - ${item.snippet}`)
        .join("\n");
      return res.json({
        reply: `Web results for **${query}**:\n\n${formatted}`
      });
    } catch (searchError) {
      return res.status(500).json({
        error: `Web search failed. ${String(searchError?.message || "Please try again.")}`
      });
    }
  }

  const trimmedHistory = history.slice(-10);
  const chatMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: "user", content: userMessage }
  ];

  try {
    // #region agent log
    fetch("http://127.0.0.1:7455/ingest/e1268678-7cd2-402b-92e5-e6fe5159353d", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "de0085" },
      body: JSON.stringify({
        sessionId: "de0085",
        runId: "pre-fix",
        hypothesisId: "H17",
        location: "backend/server/index.js:71",
        message: "Calling OpenAI",
        data: { chatMessageCount: chatMessages.length, lastRole: chatMessages[chatMessages.length - 1]?.role },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    const completion = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: chatMessages,
      temperature: 0.6
    });

    const answer = completion.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return res.status(502).json({
        error: "No response received from AI service."
      });
    }

    return res.json({ reply: answer });
  } catch (apiError) {
    // #region agent log
    fetch("http://127.0.0.1:7455/ingest/e1268678-7cd2-402b-92e5-e6fe5159353d", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "de0085" },
      body: JSON.stringify({
        sessionId: "de0085",
        runId: "pre-fix",
        hypothesisId: "H17",
        location: "backend/server/index.js:91",
        message: "OpenAI call failed",
        data: { errorMessage: String(apiError?.message || ""), errorName: String(apiError?.name || "") },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    const statusCode =
      typeof apiError?.status === "number" && apiError.status >= 400
        ? apiError.status
        : 500;
    const errorMessage = String(apiError?.message || "");
    const isQuotaError = statusCode === 429 || /quota|billing/i.test(errorMessage);

    return res.status(isQuotaError ? 429 : statusCode).json({
      error: isQuotaError
        ? "AI provider quota exceeded. Please add billing or increase usage limits, then try again."
        : "Failed to get AI response.",
      details:
        process.env.NODE_ENV === "development" ? errorMessage : undefined
    });
  }
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`AI backend listening on http://localhost:${config.port}`);
});

