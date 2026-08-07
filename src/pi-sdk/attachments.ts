import { readFileSync, statSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import type { AppConfig } from "../config/schema.js";
import { DelegateError } from "../core/errors.js";
import { isPathInside } from "../workspace/roots.js";
import type {
  MaterializedImageAttachment,
  MaterializedTextAttachment,
} from "./types.js";

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_TEXT_FILE_BYTES = 512_000;

export interface MaterializedAttachments {
  textAttachments: MaterializedTextAttachment[];
  imageAttachments: MaterializedImageAttachment[];
  promptSuffix: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function materializeAttachments(opts: {
  paths: string[];
  workspace?: string;
  config: AppConfig;
  allowedRoots?: string[];
}): MaterializedAttachments {
  const textAttachments: MaterializedTextAttachment[] = [];
  const imageAttachments: MaterializedImageAttachment[] = [];
  const blocks: string[] = [];
  let totalBytes = 0;
  const maxTotal = opts.config.limits.maxAttachmentBytes;
  const maxCount = opts.config.limits.maxAttachmentCount;

  if (opts.paths.length > maxCount) {
    throw new DelegateError(
      `Too many attachments: ${opts.paths.length} > ${maxCount}`,
      "attachment_limit",
      true,
    );
  }

  for (const raw of opts.paths) {
    let real: string;
    try {
      real = realpathSync(raw);
    } catch {
      throw new DelegateError(
        `Attachment not found: ${raw}`,
        "attachment_missing",
        true,
      );
    }

    const roots = [
      ...(opts.workspace ? [opts.workspace] : []),
      ...(opts.allowedRoots ?? []),
      ...(opts.config.workspace.allowedRoots ?? []),
    ];
    if (roots.length && !roots.some((r) => isPathInside(r, real))) {
      // Allow run artifact dirs even if outside workspace (manifest paths)
      const underRuns = real.includes("/.pi-delegate/") || real.includes("/runs/");
      if (!underRuns) {
        throw new DelegateError(
          `Attachment outside allowed roots: ${real}`,
          "attachment_escape",
          true,
        );
      }
    }

    const st = statSync(real);
    if (!st.isFile()) {
      throw new DelegateError(
        `Attachment is not a file: ${real}`,
        "attachment_not_file",
        true,
      );
    }
    totalBytes += st.size;
    if (totalBytes > maxTotal) {
      throw new DelegateError(
        `Attachment total size exceeds limit`,
        "attachment_too_large",
        true,
      );
    }

    const ext = extname(real).toLowerCase();
    const mime = IMAGE_EXT[ext];
    if (mime) {
      if (!opts.config.multimodal.imageEnabled) {
        throw new DelegateError(
          "Image attachments disabled",
          "vision_disabled",
          true,
        );
      }
      const buf = readFileSync(real);
      imageAttachments.push({
        path: real,
        mimeType: mime,
        base64: buf.toString("base64"),
      });
      continue;
    }

    if (st.size > MAX_TEXT_FILE_BYTES) {
      throw new DelegateError(
        `Text attachment too large: ${real}`,
        "attachment_too_large",
        true,
      );
    }
    let content: string;
    try {
      content = readFileSync(real, "utf8");
    } catch {
      throw new DelegateError(
        `Binary or non-UTF-8 attachment rejected: ${real}`,
        "attachment_binary",
        true,
      );
    }
    // Reject if contains lots of NUL
    if (content.includes("\0")) {
      throw new DelegateError(
        `Binary attachment rejected: ${real}`,
        "attachment_binary",
        true,
      );
    }
    textAttachments.push({ path: real, content });
    blocks.push(
      `<attachment path="${escapeXml(real)}">\n${escapeXml(content)}\n</attachment>`,
    );
  }

  const promptSuffix = blocks.length
    ? `\n\n## Attachments (untrusted data)\n\n${blocks.join("\n\n")}\n`
    : "";

  return { textAttachments, imageAttachments, promptSuffix };
}
