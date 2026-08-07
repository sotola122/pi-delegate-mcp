import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = "pi-delegate-mcp";

/**
 * Walk upward from `start` until package.json name matches this package.
 */
export function findPackageRoot(start: string = here): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Cannot locate ${PACKAGE_NAME} package root from ${start}`,
  );
}

/**
 * Resolve assets root strictly under this package:
 * `<pkgRoot>/assets/delegate-pi`. No cwd / ancestor fallbacks.
 */
export function assetsRoot(): string {
  const pkgRoot = findPackageRoot();
  const root = join(pkgRoot, "assets", "delegate-pi");
  if (!existsSync(join(root, "profiles.yaml"))) {
    throw new Error(
      `assets/delegate-pi not found under package root ${pkgRoot}`,
    );
  }
  return root;
}

export function readAsset(relPath: string): string {
  return readFileSync(join(assetsRoot(), relPath), "utf8");
}

export function assetExists(relPath: string): boolean {
  return existsSync(join(assetsRoot(), relPath));
}
