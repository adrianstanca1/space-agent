#!/usr/bin/env node

const { runDesktopPackaging } = require("./desktop-builder");

function hasHelpFlag(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

function printHelp() {
  console.log("macOS development build script");
  console.log("");
  console.log("Usage:");
  console.log("  node packaging/scripts/macos-dev-build.js [options]");
  console.log("");
  console.log("Defaults:");
  console.log("  --dir");
  console.log("  SKIP_SIGNING=1 when unset");
  console.log("");
  console.log("This wrapper forwards the remaining options to macos packaging.");
  console.log("");
  console.log("Options:");
  console.log("  --app-version <tag> Desktop app version or tag, for example v0.22 or 0.22.");
  console.log("  --arch <list>      Arch list: x64, arm64, universal.");
  console.log("  --x64              Shortcut for --arch x64.");
  console.log("  --arm64            Shortcut for --arch arm64.");
  console.log("  --universal        Shortcut for --arch universal.");
  console.log("  --dry-run          Print the resolved packaging plan without building.");
}

function withDefaultDirArg(argv) {
  return argv.includes("--dir") ? [...argv] : ["--dir", ...argv];
}

function ensureSkipSigningDefault(env = process.env) {
  if (typeof env.SKIP_SIGNING === "string" && env.SKIP_SIGNING.trim()) {
    return;
  }

  env.SKIP_SIGNING = "1";
}

const argv = process.argv.slice(2);

if (hasHelpFlag(argv)) {
  printHelp();
  process.exit(0);
}

ensureSkipSigningDefault();

runDesktopPackaging("macos", withDefaultDirArg(argv)).catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
