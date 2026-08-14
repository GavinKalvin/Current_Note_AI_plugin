import { hashText } from "./hash";
import type {
  EditOperationInput,
  EditProposalCandidate,
  EditProposalLimits,
  EditProposalPayload,
  ValidatedEditOperation,
} from "../types";

export type EditProposalErrorCode =
  | "invalid-json"
  | "invalid-schema"
  | "needs-segmentation"
  | "too-many-operations"
  | "ambiguous-anchor"
  | "missing-anchor"
  | "overlapping-operations"
  | "change-too-large"
  | "empty-selection";

export class EditProposalError extends Error {
  constructor(
    public readonly code: EditProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditProposalError";
  }
}

const DEFAULT_LIMITS: EditProposalLimits = {
  maxOperations: 20,
  maxChangeRatio: 0.5,
  maxFieldCharacters: 200_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxCharacters: number,
  allowEmpty = false,
): string {
  const value = record[key];
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maxCharacters
  ) {
    throw new EditProposalError(
      "invalid-schema",
      `Field \"${key}\" is missing or invalid.`,
    );
  }
  return value;
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  maxItems: number,
  allowEmpty: boolean,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) {
    throw new EditProposalError("invalid-schema", `Field \"${key}\" is missing or invalid.`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 1_000) {
      throw new EditProposalError("invalid-schema", `Field \"${key}\" contains an invalid item.`);
    }
    return item;
  });
}

function parsePayload(raw: string, limits: EditProposalLimits): EditProposalPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EditProposalError("invalid-json", "The provider did not return valid JSON.");
  }

  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new EditProposalError(
      "invalid-schema",
      "The edit proposal schema version is missing or unsupported.",
    );
  }

  const summary = requireString(value, "summary", 4_000);
  let coveredTargets: string[] | undefined;
  let uncoveredTargets: string[] | undefined;
  if (value.schemaVersion === 2) {
    if (value.status !== "complete" && value.status !== "needs_segmentation") {
      throw new EditProposalError("invalid-schema", "The edit proposal status is missing or invalid.");
    }
    coveredTargets = requireStringArray(value, "coveredTargets", 100, true);
    uncoveredTargets = requireStringArray(
      value,
      "uncoveredTargets",
      100,
      value.status === "complete",
    );
    if (value.status === "needs_segmentation") {
      if (!Array.isArray(value.operations) || value.operations.length !== 0) {
        throw new EditProposalError(
          "invalid-schema",
          "A needs_segmentation response must not contain partial edit operations.",
        );
      }
      throw new EditProposalError(
        "needs-segmentation",
        `${summary} Remaining scope: ${uncoveredTargets.join("; ")}`,
      );
    }
    if (uncoveredTargets.length !== 0) {
      throw new EditProposalError(
        "invalid-schema",
        "A complete edit proposal cannot contain uncovered targets.",
      );
    }
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new EditProposalError(
      "invalid-schema",
      "The edit proposal does not contain any operations.",
    );
  }
  if (value.operations.length > limits.maxOperations) {
    throw new EditProposalError(
      "too-many-operations",
      `The proposal contains more than ${limits.maxOperations} operations.`,
    );
  }

  const ids = new Set<string>();
  const operations: EditOperationInput[] = value.operations.map((item) => {
    if (!isRecord(item)) {
      throw new EditProposalError("invalid-schema", "An edit operation is not an object.");
    }
    const id = requireString(item, "id", 120);
    if (ids.has(id)) {
      throw new EditProposalError("invalid-schema", `Duplicate operation id: ${id}`);
    }
    ids.add(id);

    return {
      id,
      oldText: requireString(item, "oldText", limits.maxFieldCharacters),
      newText: requireString(item, "newText", limits.maxFieldCharacters, true),
      reason: requireString(item, "reason", 4_000),
    };
  });

  return {
    schemaVersion: value.schemaVersion,
    status: value.schemaVersion === 2 ? "complete" : undefined,
    summary,
    coveredTargets,
    uncoveredTargets,
    operations,
  };
}

function locateUniqueAnchor(baseText: string, operation: EditOperationInput): ValidatedEditOperation {
  const start = baseText.indexOf(operation.oldText);
  if (start < 0) {
    throw new EditProposalError(
      "missing-anchor",
      `Operation ${operation.id} does not match the current snapshot.`,
    );
  }

  if (baseText.indexOf(operation.oldText, start + 1) >= 0) {
    throw new EditProposalError(
      "ambiguous-anchor",
      `Operation ${operation.id} matches more than one location.`,
    );
  }

  return {
    ...operation,
    start,
    end: start + operation.oldText.length,
  };
}

export function validateEditProposal(
  raw: string,
  baseText: string,
  partialLimits: Partial<EditProposalLimits> = {},
): EditProposalCandidate {
  const limits = { ...DEFAULT_LIMITS, ...partialLimits };
  const payload = parsePayload(raw, limits);
  const operations = payload.operations
    .map((operation) => locateUniqueAnchor(baseText, operation))
    .sort((left, right) => left.start - right.start);

  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1];
    const current = operations[index];
    if (previous && current && current.start < previous.end) {
      throw new EditProposalError(
        "overlapping-operations",
        `Operations ${previous.id} and ${current.id} overlap.`,
      );
    }
  }

  const changedCharacters = operations.reduce(
    (total, operation) => total + Math.max(operation.oldText.length, operation.newText.length),
    0,
  );
  const changeRatio = changedCharacters / Math.max(1, baseText.length);
  if (changeRatio > limits.maxChangeRatio) {
    throw new EditProposalError(
      "change-too-large",
      `The proposal changes ${Math.round(changeRatio * 100)}% of the note, above the configured limit.`,
    );
  }

  return {
    summary: payload.summary,
    operations,
    baseText,
    baseHash: hashText(baseText),
    changedCharacters,
    changeRatio,
  };
}

export function compileSelectedOperations(
  candidate: EditProposalCandidate,
  selectedIds: ReadonlySet<string>,
): { afterText: string; operations: ValidatedEditOperation[] } {
  const operations = candidate.operations.filter((operation) => selectedIds.has(operation.id));
  if (operations.length === 0) {
    throw new EditProposalError("empty-selection", "Select at least one edit to apply.");
  }

  let afterText = candidate.baseText;
  for (const operation of operations.slice().sort((left, right) => right.start - left.start)) {
    if (afterText.slice(operation.start, operation.end) !== operation.oldText) {
      throw new EditProposalError(
        "missing-anchor",
        `Operation ${operation.id} no longer matches the proposal snapshot.`,
      );
    }
    afterText = `${afterText.slice(0, operation.start)}${operation.newText}${afterText.slice(operation.end)}`;
  }

  return { afterText, operations };
}
