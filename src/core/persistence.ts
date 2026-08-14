/**
 * Serializes persistence of a caller-owned, revisioned snapshot.
 *
 * The snapshot is intentionally read immediately before each write rather
 * than when the change is marked dirty. This keeps the coordinator independent
 * from the state it is persisting while ensuring writes observe the latest
 * state available at the time they start.
 */
export class RevisionedSaveCoordinator<T> {
  private currentRevision = 0;
  private lastPersistedRevision = 0;
  private activeFlush: Promise<void> | null = null;

  private readonly getSnapshot: () => T;
  private readonly writeSnapshot: (snapshot: T) => Promise<void>;

  public constructor(options: RevisionedSaveCoordinatorOptions<T>);
  public constructor(
    getSnapshot: () => T,
    writeSnapshot: (snapshot: T) => Promise<void>,
  );
  public constructor(
    optionsOrGetSnapshot: RevisionedSaveCoordinatorOptions<T> | (() => T),
    writeSnapshot?: (snapshot: T) => Promise<void>,
  ) {
    if (typeof optionsOrGetSnapshot === "function") {
      if (writeSnapshot === undefined) {
        throw new TypeError("writeSnapshot is required");
      }
      this.getSnapshot = optionsOrGetSnapshot;
      this.writeSnapshot = writeSnapshot;
    } else {
      this.getSnapshot = optionsOrGetSnapshot.getSnapshot;
      this.writeSnapshot = optionsOrGetSnapshot.writeSnapshot;
    }
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get persistedRevision(): number {
    return this.lastPersistedRevision;
  }

  public get isDirty(): boolean {
    return this.currentRevision > this.lastPersistedRevision;
  }

  /** Marks the caller-owned state as changed and returns its new revision. */
  public markDirty(): number {
    this.currentRevision += 1;
    return this.currentRevision;
  }

  /**
   * Persists all revisions known when this operation runs. Concurrent calls
   * join the in-flight operation, so they cannot start a second write out of
   * order.
   */
  public flush(): Promise<void> {
    if (this.activeFlush !== null) {
      return this.activeFlush;
    }

    const operation = this.flushLoop();
    this.activeFlush = operation;

    // Clear the join point for both success and failure. The rejection is
    // deliberately left on `operation`; callers must still observe failures.
    void operation.then(
      () => this.clearActiveFlush(operation),
      () => this.clearActiveFlush(operation),
    );

    return operation;
  }

  private async flushLoop(): Promise<void> {
    while (this.lastPersistedRevision < this.currentRevision) {
      const revisionBeingWritten = this.currentRevision;
      const snapshot = this.getSnapshot();

      await this.writeSnapshot(snapshot);
      this.lastPersistedRevision = Math.max(
        this.lastPersistedRevision,
        revisionBeingWritten,
      );
    }
  }

  private clearActiveFlush(operation: Promise<void>): void {
    if (this.activeFlush === operation) {
      this.activeFlush = null;
    }
  }
}
export interface RevisionedSaveCoordinatorOptions<T> {
  getSnapshot: () => T;
  writeSnapshot: (snapshot: T) => Promise<void>;
}
