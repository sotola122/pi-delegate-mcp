import type { AppConfig } from "../config/schema.js";
import type { PiExecutor } from "./types.js";
import { SdkPiExecutor } from "./executor.js";

/**
 * Create the Pi executor. SDK-only in 0.2.0.
 */
export async function createPiExecutor(
  _config?: AppConfig,
): Promise<PiExecutor> {
  return new SdkPiExecutor();
}

let overrideExecutor: PiExecutor | undefined;

/** Test injection. */
export function setPiExecutorForTests(executor: PiExecutor | undefined): void {
  overrideExecutor = executor;
}

export async function getPiExecutor(config?: AppConfig): Promise<PiExecutor> {
  if (overrideExecutor) return overrideExecutor;
  return createPiExecutor(config);
}
