// FORGE-233: the PRODUCTION gh executor. Process spawning lives in the CLI
// layer by design — src/repo-hosts/** is spawn-free (structural billing test).

import { execa } from 'execa';
import type { Exec, ExecResult } from '../../repo-hosts/github.ts';

export const ghExec: Exec = async (args): Promise<ExecResult> => {
  const result = await execa('gh', [...args], { reject: false });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 1,
  };
};
