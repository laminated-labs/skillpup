import { checkbox, select } from "@inquirer/prompts";
import type { ArtifactKind } from "./types.js";
import { formatArtifactSpecifier } from "./utils.js";

export type GenerateMergeStrategy = "merge" | "replace";

export type RegistrySkillChoice = {
  kind: ArtifactKind;
  name: string;
  version: string;
  configured: boolean;
  configuredVersion?: string;
};

export type FetchPrompts = {
  selectSkillsToGenerate(options: {
    availableSkills: RegistrySkillChoice[];
    mergeStrategy: GenerateMergeStrategy;
  }): Promise<string[]>;
  chooseGenerateMergeStrategy(options: {
    configPath: string;
    configuredSkillCount: number;
  }): Promise<GenerateMergeStrategy>;
};

function isPromptCancelError(error: unknown) {
  return error instanceof Error && error.name === "ExitPromptError";
}

export function buildRegistrySkillChoiceLabel(skill: RegistrySkillChoice) {
  const prefix = skill.kind === "skill" ? "skill" : "subagent";
  if (skill.configuredVersion && skill.configuredVersion !== skill.version) {
    return `${skill.name}  ${prefix}  latest ${skill.version}  pinned ${skill.configuredVersion}`;
  }

  return `${skill.name}  ${prefix}  ${skill.version}${skill.configured ? "  (configured)" : ""}`;
}

export function buildRegistrySkillChoiceValue(
  skill: RegistrySkillChoice,
  mergeStrategy: GenerateMergeStrategy
) {
  return mergeStrategy === "replace" && skill.configuredVersion
    ? formatArtifactSpecifier(skill.name, skill.kind, skill.configuredVersion)
    : formatArtifactSpecifier(skill.name, skill.kind);
}

export const defaultFetchPrompts: FetchPrompts = {
  async selectSkillsToGenerate({ availableSkills, mergeStrategy }) {
    try {
      return await checkbox({
        message:
          mergeStrategy === "replace"
            ? "Select the registry skills and subagents to track in this project"
            : "Select registry skills and subagents to add or update in this project",
        pageSize: Math.min(15, Math.max(availableSkills.length, 1)),
        loop: false,
        validate: (value) =>
          value.length > 0 ? true : "Select at least one skill or subagent to continue.",
        choices: availableSkills.map((skill) => ({
          name: buildRegistrySkillChoiceLabel(skill),
          value: buildRegistrySkillChoiceValue(skill, mergeStrategy),
          checked: mergeStrategy === "replace" && skill.configured,
        })),
      });
    } catch (error) {
      if (isPromptCancelError(error)) {
        throw new Error("Cancelled interactive skill selection.");
      }
      throw error;
    }
  },

  async chooseGenerateMergeStrategy({ configPath, configuredSkillCount }) {
    try {
      return await select({
        message: `Found ${configuredSkillCount} configured artifact${configuredSkillCount === 1 ? "" : "s"} in ${configPath}. How should the generated selection be applied?`,
        choices: [
          {
            name: "Merge into the existing config",
            value: "merge",
            description: "Keep existing skills and subagents and add or update the selected ones.",
          },
          {
            name: "Replace the existing config selection",
            value: "replace",
            description: "Rewrite the skills and subagents lists to match only the generated selection.",
          },
        ],
      });
    } catch (error) {
      if (isPromptCancelError(error)) {
        throw new Error("Cancelled generate mode.");
      }
      throw error;
    }
  },
};
