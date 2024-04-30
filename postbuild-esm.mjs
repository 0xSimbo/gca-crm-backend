#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(
  "lib/esm/package.json",
  JSON.stringify({
    sideEffects: false,
    type: "module",
  }),
);
