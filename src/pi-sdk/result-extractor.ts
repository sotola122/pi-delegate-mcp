export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      "text" in block
    ) {
      parts.push(String((block as { text: string }).text));
    }
  }
  return parts.join("");
}

export function extractFinalAssistantText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const assistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!assistant) return "";
  return extractTextFromContent(assistant.content);
}
