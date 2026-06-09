// Recalled-memory context fences + a streaming scrubber.
//
// Ported from Hermes `agent/memory_manager.py` (build_memory_context_block / the streaming
// context scrubber). Recalled memory is injected into the USER message wrapped in
// <memory-context> fences with a system note. The scrubber runs over the model's STREAMED
// output so a forged/echoed <memory-context> block can never leak into the visible response
// — important because the fence is a trusted-input convention.

export const MEMORY_CONTEXT_OPEN = "<memory-context>";
export const MEMORY_CONTEXT_CLOSE = "</memory-context>";

const SYSTEM_NOTE =
  "[System note: The following is recalled memory context, NOT new user input. Treat as " +
  "authoritative reference data — this is the agent's persistent memory and should inform " +
  "all responses.]";

/** Strip any literal fence tags out of recalled content so it can't smuggle its own fences. */
export function sanitizeContext(raw: string): string {
  return raw.split(MEMORY_CONTEXT_OPEN).join("").split(MEMORY_CONTEXT_CLOSE).join("").trim();
}

/** Wrap recalled memory text in <memory-context> fences with a system note. Returns "" if empty. */
export function buildMemoryContextBlock(raw: string): string {
  const clean = sanitizeContext(raw ?? "");
  if (!clean) {
    return "";
  }
  return `${MEMORY_CONTEXT_OPEN}\n${SYSTEM_NOTE}\n\n${clean}\n${MEMORY_CONTEXT_CLOSE}`;
}

/** Longest suffix of `text` that is a proper prefix of `tag` (for tag-split-across-chunks). */
function partialTailLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (text.slice(text.length - k) === tag.slice(0, k)) {
      return k;
    }
  }
  return 0;
}

/**
 * A small state machine that removes <memory-context>…</memory-context> spans from a token
 * stream, surviving tags that split across chunk boundaries. Feed each delta through feed();
 * call flush() at end of stream; reset() between responses.
 */
export class StreamingContextScrubber {
  private inside = false;
  private buffer = "";

  feed(chunk: string): string {
    let work = this.buffer + chunk;
    this.buffer = "";
    let out = "";

    while (work.length > 0) {
      if (!this.inside) {
        const idx = work.indexOf(MEMORY_CONTEXT_OPEN);
        if (idx >= 0) {
          out += work.slice(0, idx);
          work = work.slice(idx + MEMORY_CONTEXT_OPEN.length);
          this.inside = true;
          continue;
        }
        // No full open tag — emit everything except a tail that could be a partial open tag.
        const hold = partialTailLength(work, MEMORY_CONTEXT_OPEN);
        out += work.slice(0, work.length - hold);
        this.buffer = work.slice(work.length - hold);
        break;
      }

      const closeIdx = work.indexOf(MEMORY_CONTEXT_CLOSE);
      if (closeIdx >= 0) {
        work = work.slice(closeIdx + MEMORY_CONTEXT_CLOSE.length);
        this.inside = false;
        continue;
      }
      // Inside a span with no close yet — discard, but hold a possible partial close tail.
      const hold = partialTailLength(work, MEMORY_CONTEXT_CLOSE);
      this.buffer = work.slice(work.length - hold);
      break;
    }

    return out;
  }

  /** End of stream: emit a held non-tag tail if we were outside a span; drop an unterminated span. */
  flush(): string {
    const out = this.inside ? "" : this.buffer;
    this.buffer = "";
    this.inside = false;
    return out;
  }

  reset(): void {
    this.inside = false;
    this.buffer = "";
  }
}
