#!/usr/bin/env node
// src/cli/index.ts — `tollfree` command line entry point.

import { runAuditLog } from "./audit-log";
import { runDirect } from "./direct";
import { runFreeTest } from "./free-test";
import { runModelsFree } from "./models-free";
import { runProbe } from "./probe";
import { runQuota } from "./quota";
import { runRoute } from "./route";

const HELP = `tollfree — free-tier model routing and guardrails for OpenCode

Usage: tollfree <command> [options]

Commands:
  route <type>      Best worker for a task type (code, general, quick, long, heavy, review)
                    Also: list | report | record <worker> <success|fail> | --refresh
  probe             Probe the free workers and refresh free-models.json
  quota             Dashboard: today's spend, worker state, advice
  direct <prompt>   Call providers directly with circuit breaker + local quota (alias: run)
  free-test <cmd>   Benchmark the free models in opencode.jsonc (test | report | use <m> | list)
  models-free [p]   List truly free models from models.dev (--code for code models)
  audit-log         View the audit log (--date, --tool, --errors, --statistics, ...)

Environment:
  TOLLFREE_DIR      Config directory (default: OpenCode's config dir, ~/.config/opencode)
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "route":
      return runRoute(rest);
    case "probe":
      await runProbe();
      return 0;
    case "quota":
      return runQuota();
    case "direct":
    case "run":
      return runDirect(rest);
    case "free-test":
      return runFreeTest(rest);
    case "models-free":
      return runModelsFree(rest);
    case "audit-log":
      return runAuditLog(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command '${cmd}'.\n\n${HELP}\n`);
      return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`tollfree: ${(err as Error)?.message ?? err}\n`);
      process.exit(1);
    }
  );
}
