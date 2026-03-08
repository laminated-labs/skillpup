import { createRequire } from "node:module";
import { Command } from "commander";
import { buryInit, burySkill } from "./bury.js";
import { fetchSkills } from "./fetch.js";
import { runWithSpinner } from "./progress.js";

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
    .option("--generate", "Generate config entries from the registry before fetching")
    .option("--all", "When used with --generate, select every available registry skill")
    .option("--merge", "When used with --generate, merge generated skills into the existing config")
    .option("--replace", "When used with --generate, replace the existing config skill list")
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
          generate: options.generate,
          all: options.all,
          mergeStrategy: options.replace ? "replace" : options.merge ? "merge" : undefined,
        });
      const result = options.generate
        ? await task()
        : await runWithSpinner("Tracking the scent...", task);

      const installedRefs = result.installed.map((skill) => `${skill.name}@${skill.version}`);
      if (installedRefs.length > 0) {
        console.log(`Fetched ${installedRefs.join(", ")}`);
        return;
      }

      if (result.removed.length > 0) {
        console.log("Fetch sync complete");
        return;
      }

      console.log("No skills to fetch");
    });

  const bury = program
    .command("bury")
    .description("Bury a skill in the registry")
    .argument("[source-git-url]", "Git repository URL or local path containing the skill")
    .option("--path <skill-dir>", "Path to the skill root within the source repository")
    .option("--ref <git-ref>", "Git ref to import")
    .option("--version <stored-version>", "Version to record in the registry")
    .option("--name <skill-name>", "Skill name override")
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

  await program.parseAsync(argv);
}

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
