import { DelegateError } from "../core/errors.js";
import { compactJson } from "./compact.js";

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
        text: compactJson(value),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
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
          text: compactJson({
            status: "failed",
            code: err.code,
            err: err.message,
          }),
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
        text: compactJson({
          status: "failed",
          code: "internal_error",
          err: message,
        }),
      },
    ],
    isError: true,
  };
}
