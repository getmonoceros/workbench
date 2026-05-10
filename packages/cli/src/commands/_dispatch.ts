import { consola } from 'consola';

// Shared exit-code dispatcher: runs the orchestrator, propagates its
// exit code, and turns thrown errors into a clean console message + exit 1.
export async function dispatch(runner: () => Promise<number>): Promise<never> {
  try {
    const exitCode = await runner();
    process.exit(exitCode);
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
