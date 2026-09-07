import { defaultRegistry } from "./registry.ts";
import { registerAll } from "./register.ts";
import { run } from "./index.ts";

registerAll(defaultRegistry);

function main(): void {
  run(process.argv.slice(2), {
    tty: process.stdout.isTTY === true,
    env: process.env as Record<string, string | undefined>,
  }).then((result) => {
    if (typeof result.stdout === "string") {
      process.stdout.write(result.stdout);
    } else {
      for (const chunk of result.stdout) process.stdout.write(chunk);
    }
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    process.exit(result.code);
  });
}

main();
