import { describe, expect, it } from "vitest";

import { RevisionedSaveCoordinator } from "../src/core/persistence";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RevisionedSaveCoordinator", () => {
  it("does not write when there is no dirty revision", async () => {
    const writes: string[] = [];
    const coordinator = new RevisionedSaveCoordinator(
      () => "snapshot",
      async (snapshot) => {
        writes.push(snapshot);
      },
    );

    await coordinator.flush();

    expect(writes).toEqual([]);
    expect(coordinator.revision).toBe(0);
    expect(coordinator.persistedRevision).toBe(0);
    expect(coordinator.isDirty).toBe(false);
  });

  it("writes one current snapshot for one dirty revision", async () => {
    let snapshot = "first";
    const writes: string[] = [];
    const coordinator = new RevisionedSaveCoordinator(
      () => snapshot,
      async (value) => {
        writes.push(value);
      },
    );

    expect(coordinator.markDirty()).toBe(1);
    await coordinator.flush();

    expect(writes).toEqual(["first"]);
    expect(coordinator.persistedRevision).toBe(1);
    expect(coordinator.isDirty).toBe(false);
  });

  it("saves the latest snapshot when a revision arrives during a write", async () => {
    let snapshot = "first";
    const writes: string[] = [];
    const firstWrite = deferred<void>();
    const coordinator = new RevisionedSaveCoordinator(
      () => snapshot,
      async (value) => {
        writes.push(value);
        if (writes.length === 1) {
          await firstWrite.promise;
        }
      },
    );

    coordinator.markDirty();
    const flushing = coordinator.flush();
    await Promise.resolve();
    snapshot = "latest";
    expect(coordinator.markDirty()).toBe(2);
    firstWrite.resolve();
    await flushing;

    expect(writes).toEqual(["first", "latest"]);
    expect(coordinator.persistedRevision).toBe(2);
    expect(coordinator.isDirty).toBe(false);
  });

  it("shares concurrent flushes and preserves write order", async () => {
    let snapshot = "first";
    const writes: string[] = [];
    const firstWrite = deferred<void>();
    const coordinator = new RevisionedSaveCoordinator(
      () => snapshot,
      async (value) => {
        writes.push(value);
        if (writes.length === 1) {
          await firstWrite.promise;
        }
      },
    );

    coordinator.markDirty();
    const firstFlush = coordinator.flush();
    const secondFlush = coordinator.flush();
    expect(secondFlush).toBe(firstFlush);

    snapshot = "latest";
    coordinator.markDirty();
    firstWrite.resolve();
    await Promise.all([firstFlush, secondFlush]);

    expect(writes).toEqual(["first", "latest"]);
    expect(coordinator.persistedRevision).toBe(2);
  });

  it("keeps the revision dirty after failure and allows a later retry", async () => {
    let attempts = 0;
    const writes: string[] = [];
    const coordinator = new RevisionedSaveCoordinator(
      () => "snapshot",
      async (snapshot) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary failure");
        }
        writes.push(snapshot);
      },
    );

    coordinator.markDirty();
    await expect(coordinator.flush()).rejects.toThrow("temporary failure");
    expect(coordinator.persistedRevision).toBe(0);
    expect(coordinator.isDirty).toBe(true);

    await coordinator.flush();
    expect(writes).toEqual(["snapshot"]);
    expect(coordinator.persistedRevision).toBe(1);
    expect(coordinator.isDirty).toBe(false);
  });
});
