export function validateChatPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Invalid request body.";
  }

  const { message, history } = payload;

  if (typeof message !== "string" || !message.trim()) {
    return "Message is required.";
  }

  if (message.length > 2500) {
    return "Message is too long (max 2500 characters).";
  }

  if (history && !Array.isArray(history)) {
    return "History must be an array.";
  }

  if (Array.isArray(history)) {
    const valid = history.every((item) => {
      if (!item || typeof item !== "object") return false;
      const roleOk = item.role === "user" || item.role === "assistant";
      const contentOk =
        typeof item.content === "string" &&
        item.content.length > 0 &&
        item.content.length <= 2500;
      return roleOk && contentOk;
    });
    if (!valid) {
      return "History messages are invalid.";
    }
  }

  return null;
}

