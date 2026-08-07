import { VERSION } from "@earendil-works/pi-coding-agent";

export function getPiSdkVersion(): string {
  return typeof VERSION === "string" && VERSION.length > 0 ? VERSION : "unknown";
}
