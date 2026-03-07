import ora from "ora";

export async function runWithSpinner<T>(text: string, task: () => Promise<T>) {
  const spinner = ora({
    text,
    discardStdin: false,
  }).start();

  try {
    const result = await task();
    spinner.stop();
    return result;
  } catch (error) {
    spinner.fail(text);
    throw error;
  }
}
