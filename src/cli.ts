import { createRequire } from "node:module";
import { Command } from "commander";
import { buryInit, burySkill, refreshBuriedSkill } from "./bury.js";
import { fetchSkills } from "./fetch.js";
import { runWithSpinner } from "./progress.js";
import {
  formatRegistryUpdateSummary,
  updateRegistryArtifacts,
} from "./registry-update.js";
import {
  formatProjectUpdateSummary,
  updateProjectArtifacts,
} from "./update.js";
import { pathExists } from "./fs-utils.js";
import { normalizeStoredSourceUrl } from "./source-spec.js";
import { formatArtifactRef } from "./utils.js";
import { formatSniffReport, formatSniffSummary, sniffSkills } from "./sniff.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

async function isSourceModeTarget(target: string, cwd: string) {
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target === "." ||
    target === ".." ||
    target.startsWith("git@") ||
    target.includes("://")
  ) {
    return true;
  }

  return pathExists(normalizeStoredSourceUrl(target, cwd));
}

export async function runCli(argv: string[] = process.argv) {
  const program = new Command();

  program
    .enablePositionalOptions()
    .name("skillpup")
    .description("Private registry workflow for agent skills and subagents.")
    .version(packageJson.version);

  program
    .command("update")
    .argument("[artifacts...]", "Configured artifact names or kind:name selectors")
    .option("--registry <path-or-git-url>", "Override the configured registry for this run")
    .option("--apply", "Apply selected available updates")
    .option("--all", "When used with --apply, apply every available update")
    .option("--commit", "Commit config and lockfile changes when applying")
    .action(async (artifacts: string[], options) => {
      const result = await updateProjectArtifacts({
        artifactSpecs: artifacts,
        registry: options.registry,
        apply: options.apply,
        all: options.all,
        commit: options.commit,
      });

      if (!options.apply) {
        for (const line of formatProjectUpdateSummary(result.entries)) {
          console.log(line);
        }
        return;
      }

      const updatedRefs = result.appliedEntries
        .filter(
          (entry) => entry.status === "version-bump" || entry.status === "digest-refresh"
        )
        .map((entry) => formatArtifactRef(entry.name, entry.targetVersion, entry.kind));
      if (updatedRefs.length > 0) {
        console.log(`Updated ${updatedRefs.join(", ")}`);
        return;
      }

      console.log("No project updates applied");
    });

  program
    .command("sniff")
    .description("Look up Tego security assessments for skills")
    .argument(
      "[targets...]",
      "Configured skill names, a source repository/path, or registry artifact selectors"
    )
    .option("--registry <path-or-git-url>", "Registry path or git URL for registry mode")
    .option("--path <artifact-path>", "Path to the skill root within the source repository")
    .option("--ref <git-ref>", "Git ref to inspect in source mode")
    .action(async (targets: string[], options) => {
      if (options.registry && (options.path || options.ref)) {
        throw new Error("The --path and --ref options are only valid in source mode.");
      }

      const sourceMode =
        !options.registry &&
        (Boolean(options.path || options.ref) ||
          (targets.length === 1 &&
            (await isSourceModeTarget(targets[0]!, process.cwd()))));
      if (sourceMode && targets.length !== 1) {
        throw new Error("Source mode requires exactly one source repository or path.");
      }

      const result = await runWithSpinner("Sniffing around...", () =>
        sniffSkills({
          artifactSpecs: options.registry || !sourceMode ? targets : undefined,
          registry: options.registry,
          sourceGitUrl: sourceMode ? targets[0] : undefined,
          path: options.path,
          ref: options.ref,
        })
      );

      for (const line of formatSniffReport(result.entries)) {
        console.log(line);
      }
      console.log(formatSniffSummary(result.entries));
    });

  program
    .command("fetch")
    .argument("[skills...]", "Artifact names or kind:name@version specifiers")
    .option("--registry <path-or-git-url>", "Override the configured registry for this run")
    .option("--generate", "Generate config entries from the registry before fetching")
    .option("--all", "When used with --generate, select every available registry artifact")
    .option("--merge", "When used with --generate, merge generated artifacts into the existing config")
    .option("--replace", "When used with --generate, replace the existing config artifact lists")
    .option(
      "--force",
      "Accept digest changes for explicitly requested artifacts and rewrite their lockfile entries"
    )
    .option("--commit", "Commit config and lockfile changes")
    .action(async (skills: string[], options) => {
      if (options.merge && options.replace) {
        throw new Error("Cannot combine --merge and --replace.");
      }

      const task = () =>
        fetchSkills({
          skillSpecs: skills,
          registry: options.registry,
          commit: options.commit,
          force: options.force,
          generate: options.generate,
          all: options.all,
          mergeStrategy: options.replace ? "replace" : options.merge ? "merge" : undefined,
        });
      const result = options.generate
        ? await task()
        : await runWithSpinner("Tracking the scent...", task);

      const installedRefs = result.installed.map((artifact) =>
        formatArtifactRef(artifact.name, artifact.version, artifact.kind)
      );
      if (installedRefs.length > 0) {
        console.log(`Fetched ${installedRefs.join(", ")}`);
        return;
      }

      if (result.removed.length > 0) {
        console.log("Fetch sync complete");
        return;
      }

      console.log("No skills or subagents to fetch");
    });

  const bury = program
    .command("bury")
    .description("Bury a skill or subagent in the registry")
    .argument("[source-git-url]", "Git repository URL or local path containing the artifact")
    .option("--path <artifact-path>", "Path to the skill root or subagent TOML file within the source repository")
    .option("--ref <git-ref>", "Git ref to import")
    .option("--version <stored-version>", "Version to record in the registry")
    .option("--name <artifact-name>", "Artifact name override")
    .option("--registry <local-path>", "Local path to the registry")
    .option("--commit", "Commit registry changes")
    .action(async (sourceGitUrl: string | undefined, options) => {
      if (!sourceGitUrl) {
        bury.help({ error: true });
      }

      const result = await runWithSpinner("Burying bones...", () =>
        burySkill({
          sourceGitUrl,
          path: options.path,
          ref: options.ref,
          version: options.version,
          name: options.name,
          registry: options.registry,
          commit: options.commit,
        })
      );

      console.log(`Buried ${result.metadata.name}@${result.metadata.version}`);
    });

  bury
    .command("init")
    .argument("[directory]", "Directory to initialize as a registry")
    .action(async (directory?: string) => {
      const result = await runWithSpinner("Digging...", () =>
        buryInit({ directory })
      );
      console.log(`Ready to bury bones in ${result.registryDir}`);
    });

  bury
    .command("refresh")
    .description("Refresh digest metadata for an already-buried artifact version")
    .argument(
      "<target-folder>",
      "Path to a buried version, its skill directory, or a file inside it"
    )
    .option(
      "--registry <local-path>",
      "Local path to the registry; inferred from the target when omitted"
    )
    .option("--commit", "Commit registry changes")
    .action(async (targetFolder: string, options) => {
      const result = await runWithSpinner("Refreshing buried skill...", () =>
        refreshBuriedSkill({
          targetPath: targetFolder,
          registry: options.registry,
          commit: options.commit,
        })
      );

      const verb = result.digestChanged ? "Refreshed" : "Verified";
      console.log(`${verb} ${result.metadata.name}@${result.metadata.version}`);
    });

  bury
    .command("update")
    .description("Check for newer upstream artifact revisions and optionally publish them")
    .argument("[artifacts...]", "Artifact names or kind:name selectors")
    .option("--registry <local-path>", "Local path to the registry; inferred when omitted")
    .option("--apply", "Publish selected available updates")
    .option("--all", "When used with --apply, publish every available update")
    .option("--commit", "Commit registry changes after publishing")
    .action(async (artifacts: string[], options) => {
      const result = await updateRegistryArtifacts({
        artifactSpecs: artifacts,
        registry: options.registry,
        apply: options.apply,
        all: options.all,
        commit: options.commit,
      });

      if (!options.apply) {
        for (const line of formatRegistryUpdateSummary(result.entries)) {
          console.log(line);
        }
        return;
      }

      const publishedRefs = result.published.map((entry) =>
        formatArtifactRef(
          entry.metadata.name,
          entry.metadata.version,
          entry.metadata.kind
        )
      );
      if (publishedRefs.length > 0) {
        console.log(`Published ${publishedRefs.join(", ")}`);
        return;
      }

      console.log("No registry updates applied");
    });

  await program.parseAsync(argv);
}

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
