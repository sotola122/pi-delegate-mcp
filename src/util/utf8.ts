/** Truncate UTF-8 string to at most maxBytes without splitting a codepoint. */
export function truncateUtf8(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
