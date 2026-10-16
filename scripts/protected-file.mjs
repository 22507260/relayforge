import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";

/** Remove inherited access and reject any remaining unexpected Windows grants. */
export function protectFile(path) {
  const directory = statSync(path).isDirectory();
  if (process.platform !== "win32") {
    chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  // Encode the path as data; shell syntax in a filename cannot become code.
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = `
    $ErrorActionPreference = 'Stop'
    $relayPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
    $relayUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $relaySystem = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $relayActual = [IO.${directory ? "Directory" : "File"}]::GetAccessControl($relayPath)
    if (!$relayActual.AreAccessRulesProtected) { throw 'Protection failed.' }
    $relayRules = $relayActual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($relayRule in $relayRules) {
      if ($relayRule.IdentityReference.Value -notin @($relayUser.Value, $relaySystem.Value) -or $relayRule.AccessControlType -ne 'Allow') { throw 'Unexpected access rule.' }
    }
  `;
  try {
    const identity = execFileSync("whoami", [], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const rights = directory ? "(OI)(CI)(F)" : "(F)";
    execFileSync(
      "icacls",
      [
        path,
        "/inheritance:r",
        "/grant:r",
        `${identity}:${rights}`,
        `SYSTEM:${rights}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
  } catch {
    throw new Error(
      "Protected file access rules could not be established. Remove unexpected explicit access grants before continuing.",
    );
  }
}
