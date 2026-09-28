import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type HostProcess = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export function installedHostDiagnostics(output: string, host: () => HostProcess | undefined) {
  const runId = randomUUID();
  let tail = "";
  return {
    append(chunk: Buffer | string) {
      tail = (tail + chunk.toString()).slice(-16000);
    },
    async run<T>(
      stage: string,
      action: (evidence: { status?: number }) => Promise<T>,
      method?: string,
    ): Promise<T> {
      const evidence: { status?: number } = {};
      try {
        return await action(evidence);
      } catch (cause) {
        // Keep separate evidence even for overlapping or deliberately rejected
        // calls. Never copy exception text, request bodies or credentials here.
        const filename = `host-failure-${runId}-${randomUUID()}.json`;
        try {
          const hostProcess = host();
          const record = {
            runId,
            at: new Date().toISOString(),
            stage,
            method,
            status: evidence.status,
            hostPID: hostProcess?.pid,
            hostExitCode: hostProcess?.exitCode,
            hostSignal: hostProcess?.signalCode,
            hostOutput: tail,
          };
          await mkdir(output, { recursive: true });
          await writeFile(resolve(output, filename), JSON.stringify(record, null, 2), {
            flag: "wx",
          });
        } catch {
          console.warn(`Could not save installed-host failure evidence for ${stage}.`);
        }
        throw cause;
      }
    },
  };
}
