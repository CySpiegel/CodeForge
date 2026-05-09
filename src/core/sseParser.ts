export interface SseEvent {
  readonly data: string;
  readonly event?: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): readonly SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    while (true) {
      const boundary = this.findBoundary();
      if (boundary === -1) {
        break;
      }

      const rawEvent = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const event = parseEvent(rawEvent);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  flush(): readonly SseEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }

    const event = parseEvent(this.buffer);
    this.buffer = "";
    return event ? [event] : [];
  }

  private findBoundary(): { readonly index: number; readonly length: number } | -1 {
    const boundaries = ["\n\n", "\r\n\r\n"];
    let best: { readonly index: number; readonly length: number } | undefined;
    for (const boundary of boundaries) {
      const index = this.buffer.indexOf(boundary);
      if (index !== -1 && (!best || index < best.index)) {
        best = { index, length: boundary.length };
      }
    }
    return best ?? -1;
  }
}

function parseEvent(rawEvent: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const rawLine of rawEvent.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return { data: data.join("\n"), event };
}
