const values = process.argv.slice(2);

async function probe(base, path, expected) {
  const response = await fetch(new URL(path, base), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json"))
    throw new Error("Unexpected health response.");
  const value = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.status !== "string"
  )
    throw new Error("Unexpected health response.");
  if (response.status === 200 && value.status === expected) return true;
  if (
    expected === "ready" &&
    response.status === 503 &&
    value.status === "not_ready"
  )
    return false;
  throw new Error("Unexpected health response.");
}

try {
  if (values.length > 1) throw new Error("One origin is required.");
  const base = new URL(values[0] ?? "http://localhost:3000");
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("A plain HTTP or HTTPS origin is required.");
  const [alive, ready] = await Promise.all([
    probe(base, "/api/health/live", "alive"),
    probe(base, "/api/health/ready", "ready"),
  ]);
  console.log(
    `Web: ${alive ? "alive" : "unavailable"} · Pipeline: ${ready ? "ready" : "not ready"}`,
  );
  if (!alive || !ready) process.exitCode = 1;
} catch {
  console.error(
    "Health check failed. Confirm the origin and check the web and worker processes.",
  );
  process.exitCode = 1;
}
