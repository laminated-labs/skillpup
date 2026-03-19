import { checkbox } from "@inquirer/prompts";
import type { ArtifactKind } from "./types.js";
import { formatArtifactSpecifier } from "./utils.js";

export type UpdateSelectionChoice = {
  kind: ArtifactKind;
  name: string;
  currentVersion: string;
  targetVersion: string;
  status: "version-bump" | "digest-refresh";
  detail?: string;
};

export type UpdatePrompts = {
  selectUpdates(options: {
    availableUpdates: UpdateSelectionChoice[];
    message: string;
  }): Promise<string[]>;
};

function isPromptCancelError(error: unknown) {
  return error instanceof Error && error.name === "ExitPromptError";
}

export function buildUpdateChoiceValue(choice: UpdateSelectionChoice) {
  return formatArtifactSpecifier(choice.name, choice.kind);
}

export function buildUpdateChoiceLabel(choice: UpdateSelectionChoice) {
  const prefix = choice.kind === "skill" ? "skill" : "subagent";
  const status =
    choice.status === "digest-refresh" ? "digest refresh" : "update available";
  const detail = choice.detail ? `  ${choice.detail}` : "";
  return `${choice.name}  ${prefix}  ${choice.currentVersion} -> ${choice.targetVersion}  ${status}${detail}`;
}

export const defaultUpdatePrompts: UpdatePrompts = {
  async selectUpdates({ availableUpdates, message }) {
    try {
      return await checkbox({
        message,
        pageSize: Math.min(15, Math.max(availableUpdates.length, 1)),
        loop: false,
        validate: (value) =>
          value.length > 0 ? true : "Select at least one artifact to continue.",
        choices: availableUpdates.map((choice) => ({
          name: buildUpdateChoiceLabel(choice),
          value: buildUpdateChoiceValue(choice),
        })),
      });
    } catch (error) {
      if (isPromptCancelError(error)) {
        throw new Error("Cancelled update selection.");
      }
      throw error;
    }
  },
};
