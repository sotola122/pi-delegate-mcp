import type { AppConfig } from "../config/schema.js";
import type { Modality } from "../prompt/assembler.js";
import { DelegateError } from "../core/errors.js";
import { loadProviderFile } from "../core/provider.js";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const PDF_EXT = /\.pdf$/i;

export function detectModalitiesFromAttachments(
  attachments: string[],
  config: AppConfig,
): Modality[] {
  const out: Modality[] = [];
  const hasImage = attachments.some((p) => IMAGE_EXT.test(p));
  const hasPdf = attachments.some((p) => PDF_EXT.test(p));

  if (hasImage) {
    if (!config.multimodal.imageEnabled) {
      throw new DelegateError(
        "Image attachments are disabled in config",
        "image_disabled",
        true,
      );
    }
    out.push("vision");
  }
  if (hasPdf) {
    if (!config.multimodal.documentEnabled) {
      throw new DelegateError(
        "Document/PDF modality is disabled (enable multimodal.documentEnabled)",
        "document_disabled",
        true,
      );
    }
    out.push("document");
  }
  return out;
}

export function assertVisionCapableModel(model: string): void {
  const file = loadProviderFile();
  if (!file.vision_capable_models.includes(model)) {
    throw new DelegateError(
      `Model ${model} is not vision-capable`,
      "model_not_vision_capable",
      true,
    );
  }
}

export function mergeModalities(
  explicit: Modality[] | undefined,
  detected: Modality[],
): Modality[] {
  const set = new Set<Modality>([...(explicit ?? []), ...detected]);
  return ["vision", "document", "browser"].filter((m) =>
    set.has(m as Modality),
  ) as Modality[];
}
