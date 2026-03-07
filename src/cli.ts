import { createRequire } from "node:module";
import { Command } from "commander";
import { buryAdd, buryInit } from "./bury.js";
import { fetchSkills } from "./fetch.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export async function runCli(argv: string[] = process.argv) {
  const program = new Command();

  program
    .name("skillpup")
    .description("Private registry workflow for agent skills.")
    .version(packageJson.version, "-V, --cli-version");

  program
    .command("fetch")
    .argument("[skills...]", "Skill names or name@version specifiers")
    .option("--registry <path-or-git-url>", "Override the configured registry for this run")
    .option("--commit", "Commit config and lockfile changes")
    .action(async (skills: string[], options) => {
      await fetchSkills({
        skillSpecs: skills,
        registry: options.registry,
        commit: options.commit,
      });
    });

  const bury = program.command("bury").description("Registry publishing commands");

  bury
    .command("init")
    .argument("[directory]", "Directory to initialize as a registry")
    .action(async (directory?: string) => {
      await buryInit({ directory });
    });

  bury
    .command("add")
    .argument("<source-git-url>", "Git repository URL or local path containing the skill")
    .option("--path <skill-dir>", "Path to the skill root within the source repository")
    .option("--ref <git-ref>", "Git ref to import")
    .option("--version <stored-version>", "Version to record in the registry")
    .option("--name <skill-name>", "Skill name override")
    .option("--registry <local-path>", "Local path to the registry")
    .option("--commit", "Commit registry changes")
    .action(async (sourceGitUrl: string, options) => {
      await buryAdd({
        sourceGitUrl,
        path: options.path,
        ref: options.ref,
        version: options.version,
        name: options.name,
        registry: options.registry,
        commit: options.commit,
      });
    });

  await program.parseAsync(argv);
}

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
