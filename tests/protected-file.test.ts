import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  statSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("signing setup protects new files and refuses unexpected explicit Windows access", () => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-protected-file-"));
  const filename = join(directory, "synthetic-fixture.txt");
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "scripts", "protected-file.mjs"),
  ).href;
  const protect = (path: string) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const {protectFile}=await import(process.argv[1]);protectFile(process.argv[2]);",
        moduleUrl,
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
  try {
    protect(directory);
    writeFileSync(
      filename,
      "This disposable fixture contains no authentication material.",
    );
    protect(filename);
    if (process.platform === "win32") {
      execFileSync("icacls", [filename, "/grant", "*S-1-1-0:(R)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      assert.throws(
        () => protect(filename),
        (error) => {
          const failure = error as { stderr?: Buffer };
          return (
            failure.stderr
              ?.toString()
              .includes("Remove unexpected explicit access grants") === true
          );
        },
      );
    } else {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      chmodSync(filename, 0o666);
      protect(filename);
      assert.equal(statSync(filename).mode & 0o777, 0o600);
    }
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("relayforge-protected-file-"));
    rmSync(target, { recursive: true, force: true });
  }
});
