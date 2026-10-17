// Finds capture zips: each argument is a zip or a folder, searched recursively
// (dataset/<student>/<take>.zip). Folders that don't exist are skipped.
const fs = require("fs");
const path = require("path");

const findZips = (args) =>
  args.flatMap((p) => {
    if (!fs.existsSync(p)) return [];
    if (!fs.statSync(p).isDirectory()) return [p];
    return findZips(fs.readdirSync(p).sort().map((f) => path.join(p, f))).filter((f) => f.endsWith(".zip"));
  });

module.exports = { findZips };
