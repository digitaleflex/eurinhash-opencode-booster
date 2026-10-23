// Keeps the unit tests independent from API keys exported in the developer's shell.
import { KEY_ENV } from "../src/cli/common";

for (const names of Object.values(KEY_ENV)) for (const n of names) delete process.env[n];
