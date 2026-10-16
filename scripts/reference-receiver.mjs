import { readFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createReferenceReceiver, parseReferenceConfiguration } from "../lib/reference/receiver.ts";
import { loadEnvFile } from "node:process";

for (const filename of [".env.local", ".env"]) {
  try { loadEnvFile(filename); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
}

const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!["--keys-file", "--database"].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error("Use --keys-file <absolute path> --database <absolute path>.");
  argumentsMap.set(process.argv[index], process.argv[index + 1]);
}
function outsideProject(value, label) {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path outside the project.`);
  const target = resolve(value);
  const difference = relative(projectRoot, target);
  if (!difference || (!difference.startsWith(`..${sep}`) && !isAbsolute(difference))) throw new Error(`${label} must be outside the project.`);
  return target;
}
const keysFile = outsideProject(argumentsMap.get("--keys-file") ?? process.env.RELAYFORGE_REFERENCE_KEYS_FILE, "The reference keys file");
const databasePath = outsideProject(argumentsMap.get("--database") ?? process.env.RELAYFORGE_REFERENCE_DB_PATH ?? process.env.RELAYFORGE_REFERENCE_DATABASE, "The receiver database");
const readConfiguration = async () => {
  try {
    const actual = outsideProject(await realpath(keysFile), "The reference keys file");
    const stats = await stat(actual);
    if (!stats.isFile() || stats.size > 65_536 || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) throw new Error("Invalid reference receiver configuration.");
    return parseReferenceConfiguration(JSON.parse(await readFile(actual, "utf8")));
  } catch { throw new Error("The protected reference receiver configuration is unavailable."); }
};
await readConfiguration();
await mkdir(dirname(databasePath), { recursive: true });
outsideProject(await realpath(dirname(databasePath)), "The receiver database directory");
try {
  if (await realpath(databasePath) === await realpath(keysFile)) throw new Error("The receiver database and keys file must be separate.");
  outsideProject(await realpath(databasePath), "The receiver database");
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
}
const database = new DatabaseSync(databasePath);
const server = createReferenceReceiver({ database, readConfiguration });
server.listen(4100, "127.0.0.1", () => console.log("Reference receiver listening at http://127.0.0.1:4100/webhooks"));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { database.close(); });
  server.closeAllConnections();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", () => { console.error("The reference receiver could not start."); stop(); process.exitCode = 1; });
