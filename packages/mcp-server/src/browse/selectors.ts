/**
 * Snapshot refs.
 *
 * `browse.snapshot()` returns lines like `[0-73] link: Some title`. A ref is
 * `<frame>-<node>`: the frame's position in the snapshot (0 is the top page,
 * iframes follow in document order) and the element's backend node id there.
 * Element commands accept a ref in any of the CLI's spellings, a CSS selector,
 * or an XPath, and refs resolve through the most recent snapshot.
 *
 * Refs live for the duration of one program. That is what makes the server
 * stateless: nothing has to survive between requests, because a program takes
 * its own snapshot before it acts.
 */

/** A frame's document and the CDP session (process) that owns it. */
export interface FrameTarget {
  sessionId: string;
  frameId: string;
}

export interface RefMaps {
  xpathMap: Record<string, string>;
  urlMap: Record<string, string>;
  /** Snapshot frame index → where that frame lives. */
  frameMap: Record<string, FrameTarget>;
}

export function emptyRefMaps(): RefMaps {
  return { xpathMap: {}, urlMap: {}, frameMap: {} };
}

export interface ResolvedSelector {
  selector: string;
  /** Set for refs: the frame the element belongs to. */
  frame?: FrameTarget;
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

export function resolveSelector(selector: string, refMaps: RefMaps): ResolvedSelector {
  const ref = parseRef(selector);
  if (!ref) return { selector };

  const xpath = refMaps.xpathMap[ref];
  if (!xpath) {
    const known = Object.keys(refMaps.xpathMap).length;
    throw new StaleRefError(
      `Unknown ref "${ref}" — call browse.snapshot() first to populate refs ` +
        `(this program has ${known}).`,
    );
  }
  const [frameIndex = ""] = ref.split("-");
  const frame = refMaps.frameMap[frameIndex];
  return frame ? { selector: xpath, frame } : { selector: xpath };
}
