import variantExport from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSSyncVariant } from "quickjs-emscripten-core";

/**
 * The package's typings describe its CommonJS build, so under NodeNext the
 * default import is typed as `{ default: variant }` while ESM runtimes hand
 * over the variant itself. Accept either shape.
 */
export const quickjsVariant: QuickJSSyncVariant = unwrapVariant(variantExport);

function unwrapVariant(value: unknown): QuickJSSyncVariant {
  if (isSyncVariant(value)) return value;
  if (typeof value === "object" && value !== null && "default" in value && isSyncVariant(value.default)) {
    return value.default;
  }
  throw new Error("@jitl/quickjs-wasmfile-release-sync did not export a sync QuickJS variant.");
}

function isSyncVariant(value: unknown): value is QuickJSSyncVariant {
  return typeof value === "object" && value !== null && "type" in value && value.type === "sync";
}
