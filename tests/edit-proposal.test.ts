import { describe, expect, it } from "vitest";

import {
  compileSelectedOperations,
  EditProposalError,
  validateEditProposal,
} from "../src/core/edit-proposal";

function proposal(
  operations: Array<{
    id: string;
    oldText: string;
    newText: string;
    reason?: string;
  }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    summary: "Apply the requested edits.",
    operations: operations.map((operation) => ({
      reason: "Requested change.",
      ...operation,
    })),
  });
}

function expectProposalError(action: () => unknown, code: EditProposalError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(EditProposalError);
    expect((error as EditProposalError).code).toBe(code);
    return;
  }

  throw new Error(`Expected EditProposalError with code ${code}.`);
}

describe("validateEditProposal", () => {
  it("validates and compiles a legal replacement", () => {
    const candidate = validateEditProposal(
      proposal([{ id: "replace", oldText: "brown", newText: "red" }]),
      "The quick brown fox jumps.",
    );

    const result = compileSelectedOperations(candidate, new Set(["replace"]));

    expect(result.afterText).toBe("The quick red fox jumps.");
    expect(result.operations).toHaveLength(1);
  });

  it("supports deletion with an empty newText", () => {
    const candidate = validateEditProposal(
      proposal([{ id: "delete", oldText: " unnecessary", newText: "" }]),
      "Keep this unnecessary sentence.",
    );

    expect(compileSelectedOperations(candidate, new Set(["delete"])).afterText).toBe(
      "Keep this sentence.",
    );
  });

  it("supports insertion by retaining the original anchor in newText", () => {
    const candidate = validateEditProposal(
      proposal([{
        id: "insert",
        oldText: "## Details",
        newText: "## Details\n\nInserted paragraph.",
      }]),
      "# Note\n\n## Details\n",
      { maxChangeRatio: 2 },
    );

    expect(compileSelectedOperations(candidate, new Set(["insert"])).afterText).toBe(
      "# Note\n\n## Details\n\nInserted paragraph.\n",
    );
  });

  it("rejects invalid JSON with the invalid-json code", () => {
    expectProposalError(() => validateEditProposal("{not json", "note"), "invalid-json");
  });

  it("rejects an unsupported schemaVersion with the invalid-schema code", () => {
    const raw = JSON.stringify({ schemaVersion: 3, summary: "No", operations: [] });

    expectProposalError(() => validateEditProposal(raw, "note"), "invalid-schema");
  });

  it("accepts a complete schemaVersion 2 proposal", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      status: "complete",
      summary: "Replace the requested term.",
      coveredTargets: ["terminology"],
      uncoveredTargets: [],
      operations: [{
        id: "replace",
        oldText: "old term",
        newText: "new term",
        reason: "Use the requested terminology.",
      }],
    });

    expect(validateEditProposal(raw, "The old term appears once.").operations).toHaveLength(1);
  });

  it("surfaces needs_segmentation without accepting partial operations", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      status: "needs_segmentation",
      summary: "The request is too large.",
      coveredTargets: [],
      uncoveredTargets: ["remaining sections"],
      operations: [],
    });

    expectProposalError(() => validateEditProposal(raw, "note"), "needs-segmentation");
  });

  it("rejects partial operations in a needs_segmentation response", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      status: "needs_segmentation",
      summary: "The request is too large.",
      coveredTargets: ["first section"],
      uncoveredTargets: ["remaining sections"],
      operations: [{
        id: "partial",
        oldText: "note",
        newText: "NOTE",
        reason: "Partial change.",
      }],
    });

    expectProposalError(() => validateEditProposal(raw, "note"), "invalid-schema");
  });

  it("rejects a missing anchor with the missing-anchor code", () => {
    expectProposalError(
      () => validateEditProposal(
        proposal([{ id: "missing", oldText: "absent", newText: "replacement" }]),
        "present text",
      ),
      "missing-anchor",
    );
  });

  it("rejects a repeated anchor with the ambiguous-anchor code", () => {
    expectProposalError(
      () => validateEditProposal(
        proposal([{ id: "duplicate", oldText: "same", newText: "changed" }]),
        "same then same",
      ),
      "ambiguous-anchor",
    );
  });

  it("rejects overlapping operations with the overlapping-operations code", () => {
    expectProposalError(
      () => validateEditProposal(
        proposal([
          { id: "left", oldText: "abcde", newText: "left" },
          { id: "right", oldText: "cdef", newText: "right" },
        ]),
        "abcdef",
        { maxChangeRatio: 10 },
      ),
      "overlapping-operations",
    );
  });

  it("rejects proposals above maxOperations with the too-many-operations code", () => {
    expectProposalError(
      () => validateEditProposal(
        proposal([
          { id: "one", oldText: "one", newText: "1" },
          { id: "two", oldText: "two", newText: "2" },
        ]),
        "one two",
        { maxOperations: 1 },
      ),
      "too-many-operations",
    );
  });

  it("rejects proposals above maxChangeRatio with the change-too-large code", () => {
    expectProposalError(
      () => validateEditProposal(
        proposal([{ id: "large", oldText: "12345", newText: "abcde" }]),
        "1234567890",
        { maxChangeRatio: 0.49 },
      ),
      "change-too-large",
    );
  });

  it("compiles only the selected subset", () => {
    const candidate = validateEditProposal(
      proposal([
        { id: "first", oldText: "alpha", newText: "ALPHA" },
        { id: "second", oldText: "gamma", newText: "GAMMA" },
      ]),
      "alpha beta gamma delta",
    );

    const result = compileSelectedOperations(candidate, new Set(["second"]));

    expect(result.afterText).toBe("alpha beta GAMMA delta");
    expect(result.operations.map((operation) => operation.id)).toEqual(["second"]);
  });

  it("rejects an empty selection with the empty-selection code", () => {
    const candidate = validateEditProposal(
      proposal([{ id: "replace", oldText: "before", newText: "after" }]),
      "before and surrounding text",
    );

    expectProposalError(
      () => compileSelectedOperations(candidate, new Set()),
      "empty-selection",
    );
  });

  it("replaces Unicode and emoji anchors exactly", () => {
    const candidate = validateEditProposal(
      proposal([{ id: "unicode", oldText: "刻蚀🧪", newText: "等离子体刻蚀✨" }]),
      "前言：刻蚀🧪完成。",
      { maxChangeRatio: 2 },
    );

    expect(compileSelectedOperations(candidate, new Set(["unicode"])).afterText).toBe(
      "前言：等离子体刻蚀✨完成。",
    );
  });
});
