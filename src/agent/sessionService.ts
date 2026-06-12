import { SessionRecord, SessionSnapshot, SessionStore, SessionSummary } from "../core/session";
import type { AgentSessionSummary, AgentUiEvent } from "./agentUiTypes";
import { errorMessage } from "./toolText";

export interface SessionServiceDeps {
  readonly store: SessionStore | undefined;
  emit(event: AgentUiEvent): void;
}

// Owns the current session id and all interaction with the SessionStore: record persistence, lazy
// session creation, listing, deletion, and snapshot loading. The controller keeps session-state
// application (applySession) and the user-facing commands, delegating every store touch here.
export class SessionService {
  private sessionId: string | undefined;
  private sessionStartPromise: Promise<string | undefined> | undefined;

  constructor(private readonly deps: SessionServiceDeps) {}

  hasStore(): boolean {
    return Boolean(this.deps.store);
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  // Adopt an already-persisted session (after loading a snapshot).
  adoptSession(id: string): void {
    this.sessionId = id;
    this.sessionStartPromise = undefined;
  }

  clearSession(): void {
    this.sessionId = undefined;
    this.sessionStartPromise = undefined;
  }

  // Append a record, lazily creating the session on first write. No-op without a store.
  async record(factory: (sessionId: string) => SessionRecord): Promise<void> {
    if (!this.deps.store) {
      return;
    }
    const sessionId = await this.ensureSessionId();
    if (!sessionId) {
      return;
    }
    await this.deps.store.append(factory(sessionId));
  }

  // Fire-and-forget record; surfaces a persistence error to the UI but never throws to the caller.
  persist(factory: (sessionId: string) => SessionRecord): void {
    void this.record(factory).catch((error) => {
      this.deps.emit({ type: "error", text: `Failed to persist session record: ${errorMessage(error)}` });
    });
  }

  private async ensureSessionId(): Promise<string | undefined> {
    if (!this.deps.store) {
      return undefined;
    }
    if (this.sessionId) {
      return this.sessionId;
    }
    if (this.sessionStartPromise) {
      return this.sessionStartPromise;
    }
    return this.startNewSession("CodeForge session");
  }

  async startNewSession(title: string): Promise<string | undefined> {
    const store = this.deps.store;
    if (!store) {
      this.sessionId = undefined;
      this.sessionStartPromise = undefined;
      return undefined;
    }

    this.sessionId = undefined;
    const started = store.createSession(title).then(
      (snapshot) => {
        this.sessionId = snapshot.id;
        this.sessionStartPromise = undefined;
        return snapshot.id;
      },
      (error) => {
        this.sessionStartPromise = undefined;
        throw error;
      }
    );
    this.sessionStartPromise = started;
    return started;
  }

  async listSummaries(limit: number): Promise<readonly AgentSessionSummary[]> {
    if (!this.deps.store) {
      return [];
    }
    return (await this.deps.store.list(limit)).map(toAgentSessionSummary);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.deps.store ? this.deps.store.deleteSession(sessionId) : false;
  }

  async readLatest(): Promise<SessionSnapshot | undefined> {
    return this.deps.store?.readLatest();
  }

  async read(id: string): Promise<SessionSnapshot | undefined> {
    return this.deps.store?.read(id);
  }

  async exportSession(id: string): Promise<string | undefined> {
    return this.deps.store?.exportSession(id);
  }

  // Load a specific session, or the current one, or the latest — used by resume/fork/diff.
  async resolveStored(sessionId: string | undefined): Promise<SessionSnapshot | undefined> {
    const store = this.deps.store;
    if (!store) {
      return undefined;
    }
    if (sessionId) {
      return store.read(sessionId);
    }
    if (this.sessionId) {
      return store.read(this.sessionId);
    }
    return store.readLatest();
  }
}

function toAgentSessionSummary(session: SessionSummary): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    pendingApprovalCount: session.pendingApprovalCount
  };
}
