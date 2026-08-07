import type { DelegateResult } from "../core/result.js";
import { isInfrastructureError, DelegateError } from "../core/errors.js";
import { redactSecrets } from "../artifacts/redact.js";

export function jsonToMcpContent(
  value: unknown,
  isError = false,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: "text",
        text: redactSecrets(JSON.stringify(value, null, 2)),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export function resultToMcpContent(result: DelegateResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return jsonToMcpContent(result);
}

export function errorToMcpContent(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  if (err instanceof DelegateError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "failed",
              code: err.code,
              message: err.message,
            },
            null,
            2,
          ),
        },
      ],
      isError: err.infrastructure,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { status: "failed", code: "internal_error", message },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export { isInfrastructureError };
