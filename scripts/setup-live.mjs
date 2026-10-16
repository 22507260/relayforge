import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadEnvFile } from "node:process";
import { protectFile as protect } from "./protected-file.mjs";

const project = realpathSync(process.cwd());
const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => argument !== "--enable-reference"))
  throw new Error("Use setup:live with optional --enable-reference.");
if (existsSync(".env.local")) loadEnvFile(".env.local");
let directory = resolve(
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? homedir(), "RelayForge", "security")
    : join(homedir(), ".local", "share", "relayforge", "security"),
);
function externalPath(value) {
  if (!isAbsolute(value))
    throw new Error(
      "Signing files require an absolute path outside the project.",
    );
  let ancestor = resolve(value);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("The signing path cannot be resolved.");
    ancestor = parent;
  }
  const target = join(realpathSync(ancestor), ...missing);
  const difference = relative(project, target);
  if (
    !difference ||
    (!difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  )
    throw new Error("Signing files must stay outside the project.");
  return target;
}
directory = externalPath(directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
protect(directory);
const configuredMaster =
  process.env.RELAYFORGE_MASTER_KEY_FILE?.trim() || undefined;
const master = externalPath(configuredMaster ?? join(directory, "master.key"));
if (configuredMaster && !existsSync(master))
  throw new Error(
    "The configured master key is missing. Restore it from your protected backup; do not replace it.",
  );
if (!existsSync(master)) {
  const filename = resolve(
    process.env.DATABASE_PATH || ".data/relayforge.sqlite",
  );
  if (existsSync(filename)) {
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      const table = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='connection_signing_keys'",
        )
        .get();
      if (
        table &&
        Number(
          database
            .prepare("SELECT COUNT(*) AS count FROM connection_signing_keys")
            .get().count,
        ) > 0
      )
        throw new Error(
          "Existing signing history requires its original master key. Restore the protected key backup.",
        );
    } finally {
      database.close();
    }
  }
  mkdirSync(dirname(master), { recursive: true, mode: 0o700 });
  writeFileSync(master, randomBytes(32), { flag: "wx", mode: 0o600 });
}
if (readFileSync(master).length !== 32)
  throw new Error(
    "The configured master key must contain exactly 32 raw bytes.",
  );
protect(master);
const configuration = { RELAYFORGE_MASTER_KEY_FILE: master };
if (argumentsList.includes("--enable-reference")) {
  const keys = externalPath(
    process.env.RELAYFORGE_REFERENCE_KEYS_FILE?.trim() ||
      join(directory, "reference-keys.json"),
  );
  const receiverDatabase = externalPath(
    process.env.RELAYFORGE_REFERENCE_DATABASE?.trim() ||
      join(directory, "receiver.sqlite"),
  );
  mkdirSync(dirname(keys), { recursive: true, mode: 0o700 });
  if (!existsSync(keys))
    writeFileSync(
      keys,
      JSON.stringify({ mode: "healthy", connections: [] }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  if (process.platform === "win32") protect(keys);
  else chmodSync(keys, 0o600);
  Object.assign(configuration, {
    RELAYFORGE_REFERENCE_ENABLED: "true",
    RELAYFORGE_REFERENCE_KEYS_FILE: keys,
    RELAYFORGE_REFERENCE_DATABASE: receiverDatabase,
  });
}
const current = existsSync(".env.local")
  ? readFileSync(".env.local", "utf8")
  : "";
if (
  existsSync(".env.local") &&
  realpathSync(".env.local") !== join(project, ".env.local")
)
  throw new Error("The local environment file must not be a symlink.");
const names = Object.keys(configuration);
const retained = current
  .split(/\r?\n/)
  .filter((line) => !names.some((name) => line.startsWith(`${name}=`)))
  .join("\n")
  .trimEnd();
const lines = Object.entries(configuration).map(
  ([name, value]) => `${name}=${JSON.stringify(value.replaceAll("\\", "/"))}`,
);
writeFileSync(
  ".env.local",
  [retained, ...lines, ""]
    .filter((line, index) => line || index > 0)
    .join("\n"),
  { mode: 0o600 },
);
if (process.platform === "win32") protect(resolve(".env.local"));
console.log(
  "Protected live signing configuration is ready. No secrets were printed.",
);
if (argumentsList.includes("--enable-reference"))
  console.log(
    "The independent receiver is enabled. Configure its one-time connection signing key, then run npm run reference:receiver.",
  );
