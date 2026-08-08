import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ProgressCallback } from "../core/progress.js";
import type { PiDiagnostic, ToolCallSummary } from "./types.js";

export interface CollectedEvents {
  agentStarted: boolean;
  agentEnded: boolean;
  agentSettled: boolean;
  willRetry: boolean;
  toolCalls: ToolCallSummary[];
  diagnostics: PiDiagnostic[];
  messageTexts: string[];
  eventSummary: Array<Record<string, unknown>>;
  truncated: boolean;
  metadataBytes: number;
}

export interface EventCollectorOptions {
  maxEventMetadataBytes?: number;
  onProgress?: ProgressCallback;
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function createEventCollector(opts: EventCollectorOptions = {}): {
  collector: CollectedEvents;
  listener: (event: AgentSessionEvent) => void;
} {
  const maxBytes = opts.maxEventMetadataBytes ?? 4_194_304;
  const onProgress = opts.onProgress;
  const collector: CollectedEvents = {
    agentStarted: false,
    agentEnded: false,
    agentSettled: false,
    willRetry: false,
    toolCalls: [],
    diagnostics: [],
    messageTexts: [],
    eventSummary: [],
    truncated: false,
    metadataBytes: 0,
  };

  const toolStarts = new Map<string, number>();

  const pushSummary = (entry: Record<string, unknown>): void => {
    if (collector.truncated) return;
    const line = JSON.stringify(entry);
    const n = utf8Len(line) + 1;
    if (collector.metadataBytes + n > maxBytes) {
      collector.truncated = true;
      collector.diagnostics.push({
        level: "warn",
        code: "event_metadata_truncated",
        message: `event metadata exceeded ${maxBytes} bytes`,
      });
      return;
    }
    collector.metadataBytes += n;
    collector.eventSummary.push(entry);
  };

  const pushMessage = (text: string): void => {
    if (collector.truncated) return;
    const n = utf8Len(text);
    if (collector.metadataBytes + n > maxBytes) {
      collector.truncated = true;
      collector.diagnostics.push({
        level: "warn",
        code: "event_metadata_truncated",
        message: `event metadata exceeded ${maxBytes} bytes`,
      });
      return;
    }
    collector.metadataBytes += n;
    collector.messageTexts.push(text);
  };

  const listener = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case "agent_start":
        collector.agentStarted = true;
        onProgress?.({
          phase: "prompting",
          agentStarted: true,
          toolCalls: collector.toolCalls.length,
        });
        pushSummary({ type: "agent_start" });
        break;
      case "agent_end":
        collector.agentEnded = true;
        collector.willRetry = Boolean(
          (event as { willRetry?: boolean }).willRetry,
        );
        onProgress?.({
          phase: "finalizing",
          agentStarted: true,
          toolCalls: collector.toolCalls.length,
        });
        pushSummary({
          type: "agent_end",
          willRetry: collector.willRetry,
        });
        break;
      case "agent_settled":
        collector.agentSettled = true;
        pushSummary({ type: "agent_settled" });
        break;
      case "tool_execution_start": {
        const e = event as {
          toolName?: string;
          toolCallId?: string;
        };
        const id = e.toolCallId ?? e.toolName ?? "tool";
        toolStarts.set(id, Date.now());
        pushSummary({
          type: "tool_execution_start",
          tool: e.toolName,
        });
        break;
      }
      case "tool_execution_end": {
        const e = event as {
          toolName?: string;
          toolCallId?: string;
          isError?: boolean;
        };
        const id = e.toolCallId ?? e.toolName ?? "tool";
        const started = toolStarts.get(id);
        collector.toolCalls.push({
          tool: e.toolName ?? "unknown",
          isError: Boolean(e.isError),
          durationMs: started !== undefined ? Date.now() - started : undefined,
        });
        onProgress?.({
          phase: "tools",
          agentStarted: collector.agentStarted,
          toolCalls: collector.toolCalls.length,
          lastTool: e.toolName ?? "unknown",
        });
        pushSummary({
          type: "tool_execution_end",
          tool: e.toolName,
          isError: Boolean(e.isError),
          durationMs: started !== undefined ? Date.now() - started : undefined,
        });
        break;
      }
      case "message_end": {
        const msg = (event as { message?: { role?: string; content?: unknown } })
          .message;
        if (msg?.role === "assistant") {
          const text = extractTextContent(msg.content);
          if (text) pushMessage(text);
        }
        pushSummary({ type: "message_end", role: msg?.role });
        break;
      }
      case "auto_retry_start":
      case "auto_retry_end":
      case "compaction_start":
      case "compaction_end":
      case "turn_start":
      case "turn_end":
        pushSummary({ type: event.type });
        break;
      default:
        break;
    }
  };

  return { collector, listener };
}

function extractTextContent(content: unknown): string {
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

export { truncateUtf8 } from "../util/utf8.js";
