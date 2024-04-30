#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(
  "lib/cjs/package.json",
  JSON.stringify({
    type: "commonjs",
  }),
);
