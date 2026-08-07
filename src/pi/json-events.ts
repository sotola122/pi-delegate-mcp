export interface JsonEvent {
  type?: string;
  willRetry?: boolean;
  [key: string]: unknown;
}

export function parseJsonlEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as JsonEvent);
    } catch {
      // skip non-json lines
    }
  }
  return events;
}

export function jsonModeSucceeded(events: JsonEvent[], exitCode: number | null): boolean {
  if (exitCode !== 0) return false;
  const agentEnd = [...events].reverse().find((e) => e.type === "agent_end");
  if (!agentEnd) return false;
  if (agentEnd.willRetry === true) return false;
  return events.some((e) => e.type === "agent_settled");
}

export function extractFinalText(events: JsonEvent[], fallbackStdout: string): string {
  const texts: string[] = [];
  for (const e of events) {
    if (e.type === "message_end" || e.type === "turn_end" || e.type === "text") {
      const content = e.content ?? e.text ?? e.message;
      if (typeof content === "string") texts.push(content);
    }
  }
  if (texts.length) return texts[texts.length - 1]!;
  // If not JSON mode, return raw stdout
  if (!events.length) return fallbackStdout;
  return fallbackStdout;
}
