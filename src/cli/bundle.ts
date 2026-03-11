import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initPathManager, getPathManager } from "../fs/index.js";
import { BundleManager } from "../bundle/manager.js";

async function main() {
  const [,, cmd, arg] = process.argv;

  const root = process.cwd();
  initPathManager(root);

  const pm = getPathManager();
  const bundleManager = BundleManager.getInstance();

  switch (cmd) {
    case "list":
      console.log("=== Packs ===");
      const packsDir = pm.global().packsDir();
      if (existsSync(packsDir)) {
        const packs = readdirSync(packsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const pack of packs) {
          console.log(`- ${pack}`);
        }
      } else {
        console.log("(No packs found)");
      }

      console.log("\n=== Backups ===");
      const backupsDir = pm.global().backupsDir();
      if (existsSync(backupsDir)) {
        const backups = readdirSync(backupsDir, { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith(".zip"))
          .map(f => f.name.replace(".zip", ""));
        for (const backup of backups) {
          console.log(`- ${backup}`);
        }
      } else {
        console.log("(No backups found)");
      }

      console.log("\n=== Current Bundle ===");
      const manifestPath = pm.bundle().manifest();
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          console.log(`Bundle ID: ${manifest.bundleId}`);
          console.log(`Source: ${manifest.source.type} -> ${manifest.source.id} (v${manifest.source.version})`);
          console.log(`Created At: ${manifest.createdAt}`);
        } catch {
          console.log("(Invalid manifest.json)");
        }
      } else {
        console.log("(No active bundle)");
      }
      break;

    case "load":
      if (!arg) {
        console.error("Usage: tsx bundle.ts load <pack-id>");
        process.exit(1);
      }
      console.log(`Loading pack '${arg}' to bundle...`);
      await bundleManager.loadPackToBundle(arg);
      console.log("Successfully loaded pack to bundle.");
      break;

    case "save":
      if (!arg) {
        console.error("Usage: tsx bundle.ts save <backup-name>");
        process.exit(1);
      }
      console.log(`Saving current bundle to backup '${arg}'...`);
      await bundleManager.saveCurrentBundleToBackup(arg);
      console.log(`Successfully saved bundle to backups/${arg}.zip`);
      break;

    case "restore":
      if (!arg) {
        console.error("Usage: tsx bundle.ts restore <backup-name>");
        process.exit(1);
      }
      const backupPath = join(pm.global().backupsDir(), `${arg}.zip`);
      console.log(`Restoring backup '${arg}' to bundle...`);
      await bundleManager.restoreBackupToBundle(backupPath);
      console.log("Successfully restored backup to bundle.");
      break;

    default:
      console.log("Usage: tsx bundle.ts <command> [argument]");
      console.log("Commands:");
      console.log("  list               - List available packs, backups, and current bundle");
      console.log("  load <pack-id>     - Load a pack into the active bundle");
      console.log("  save <backup-name> - Save current active bundle to a backup zip");
      console.log("  restore <name>     - Restore a backup zip to the active bundle");
      break;
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
