/**
 * Snapshot refs.
 *
 * `browse.snapshot()` returns lines like `[0-73] link: Some title` and a map
 * from `0-73` to an XPath. Element commands accept a ref in any of the CLI's
 * spellings, a CSS selector, or an XPath, and refs resolve through the most
 * recent snapshot.
 *
 * Refs live for the duration of one program. That is what makes the server
 * stateless: nothing has to survive between requests, because a program takes
 * its own snapshot before it acts.
 */

export interface RefMaps {
  xpathMap: Record<string, string>;
  urlMap: Record<string, string>;
}

export function emptyRefMaps(): RefMaps {
  return { xpathMap: {}, urlMap: {} };
}

/** Raised when a ref has no entry in the current snapshot. */
export class StaleRefError extends Error {
  readonly code = "stale_ref";
  constructor(message: string) {
    super(message);
    this.name = "StaleRefError";
  }
}

/** Extract a ref id from the spellings the CLI accepts, or `null` for a selector. */
export function parseRef(selector: string): string | null {
  if (selector.startsWith("@")) {
    const rest = selector.slice(1);
    return rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest;
  }
  if (/^\[\d+-\d+]$/.test(selector)) return selector.slice(1, -1);
  if (selector.startsWith("ref=")) return selector.slice(4);
  return /^\d+-\d+$/.test(selector) ? selector : null;
}

export function resolveSelector(selector: string, refMaps: RefMaps): string {
  const ref = parseRef(selector);
  if (!ref) return selector;

  const xpath = refMaps.xpathMap[ref];
  if (!xpath) {
    const known = Object.keys(refMaps.xpathMap).length;
    throw new StaleRefError(
      `Unknown ref "${ref}" — call browse.snapshot() first to populate refs ` +
        `(this program has ${known}).`,
    );
  }
  return xpath;
}
