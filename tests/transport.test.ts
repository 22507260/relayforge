import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createSocket } from "node:dgram";
import dnsPromises from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LiveTransport, isPublicAddress, validateDestinationUrl, parseRetryAfter,
  isRetryableTransportResult, LIVE_DEADLINE_MS,
  resolveDestinationAddresses,
} from "../lib/server/transport.ts";
import type { LiveDeliveryRequest, TransportResult } from "../lib/server/transport.ts";
import { createReferenceReceiver, parseReferenceConfiguration } from "../lib/reference/receiver.ts";
import type { ReferenceConfiguration } from "../lib/reference/receiver.ts";
import { createTlsFixture } from "./tls-fixture.ts";

const target = "https://hooks.relayforge.test/webhooks";
const policy = { allowedHosts: ["hooks.relayforge.test"], referenceEnabled: false };
const delivery: LiveDeliveryRequest = {
  transport: "https", destinationUrl: target, endpointId: "connection-one", eventId: "event-one", cycle: 1,
  body: JSON.stringify({ eventId: "event-one", eventType: "invoice.paid", payload: { amount: 42 }, attempt: 1, cycle: 1, createdAt: 1_800_000_000_000 }),
  timestamp: 1_800_000_000_000, signatures: [{ keyId: "key-one", signature: "a".repeat(64) }],
};

async function listen(server: Server, context: TestContext): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => { if (!server.listening) return; const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("destination policy accepts only exact HTTPS DNS names on port443", () => {
  assert.equal(validateDestinationUrl("https://HOOKS.relayforge.test:443/webhooks", policy.allowedHosts), target);
  for (const value of ["http://hooks.relayforge.test/webhooks", "https://hooks.relayforge.test:8443", "https://user:pass@hooks.relayforge.test", `${target}?`, `${target}?secret=value`, `${target}#`, "https://127.1/webhooks", "https://[::1]/webhooks", "https://hooks.relayforge.test./webhooks", "https://other.hooks.relayforge.test/webhooks", " https://hooks.relayforge.test", "https://hooks.relayforge.test\\@evil.test", `${target}${"a".repeat(2048)}`]) {
    assert.throws(() => validateDestinationUrl(value, policy.allowedHosts), value);
  }
  assert.throws(() => validateDestinationUrl(target, ["*.relayforge.test"]));
  assert.equal(new LiveTransport({ policy }).isAvailable("reference", null), false);
});

test("public address classifier rejects every private and special address family", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.1.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "192.0.0.1", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "64:ff9b::7f00:1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
});

test("mixed DNS and changed DNS are rechecked before every outbound call", async (context) => {
  const fixture = createTlsFixture();
  let requests = 0;
  const server = createServer(fixture, (_request, response) => { requests++; response.writeHead(204); response.end(); });
  const port = await listen(server, context);
  let lookups = 0;
  const transport = new LiveTransport({
    policy,
    resolve: async () => ++lookups === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
    request: (options, callback) => httpsRequest({ ...options, port, ca: fixture.cert, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback),
  });
  assert.equal((await transport.send(delivery)).statusCode, 204);
  const second = await transport.send(delivery);
  assert.equal(second.failureCode, "destination_blocked");
  assert.equal(second.statusCode, null);
  assert.equal(requests, 1);
  assert.equal(lookups, 2);
  const allMixed = new LiveTransport({ policy, resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:169.254.169.254", family: 6 }], request: () => { throw new Error("A blocked destination was contacted."); } });
  assert.equal((await allMixed.send(delivery)).failureCode, "destination_blocked");
});

test("native DNS resolves both record families and cancellation finishes pending resolution", async (context) => {
  const dns = createSocket("udp4");
  let drop = false;
  const questions: number[] = [];
  dns.on("message", (question, remote) => {
    let questionEnd = 12;
    while (question[questionEnd] !== 0) questionEnd += question[questionEnd] + 1;
    questionEnd++;
    const type = question.readUInt16BE(questionEnd);
    questionEnd += 4;
    questions.push(type);
    if (drop) return;
    const address = type === 1 ? Buffer.from([8, 8, 8, 8]) : Buffer.from("00000000000000000000000000000001", "hex");
    const header = Buffer.from(question.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4); record.writeUInt32BE(30, 6); record.writeUInt16BE(address.length, 10);
    dns.send(Buffer.concat([header, question.subarray(12, questionEnd), record, address]), remote.port, remote.address);
  });
  dns.bind(0, "127.0.0.1");
  await once(dns, "listening");
  const originalServers = dnsPromises.getServers();
  dnsPromises.setServers([`127.0.0.1:${dns.address().port}`]);
  context.after(async () => { dnsPromises.setServers(originalServers); const closed = once(dns, "close"); dns.close(); await closed; });
  const addresses = await resolveDestinationAddresses("hooks.relayforge.test", new AbortController().signal);
  assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }]);
  assert.deepEqual(new Set(questions), new Set([1, 28]));
  const transport = new LiveTransport({ policy, request: () => { throw new Error("A blocked AAAA record was contacted."); } });
  assert.equal((await transport.send(delivery)).failureCode, "destination_blocked");
  drop = true;
  const controller = new AbortController();
  const started = Date.now();
  const resolving = resolveDestinationAddresses("hooks.relayforge.test", controller.signal);
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(resolving); } finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 1_000);
});

test("native TLS keeps original host, pins validated DNS, and discards acknowledgement bodies", async (context) => {
  const proxyVariables = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"];
  const previous = proxyVariables.map((name) => process.env[name]);
  for (const name of proxyVariables) process.env[name] = name === "NODE_USE_ENV_PROXY" ? "1" : "http://127.0.0.1:1";
  context.after(() => proxyVariables.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  const fixture = createTlsFixture();
  let received = false;
  const server = createServer(fixture, (request, response) => {
    received = true;
    assert.equal(request.headers.host?.split(":")[0], "hooks.relayforge.test");
    assert.equal(request.headers["x-relayforge-connection-id"], delivery.endpointId);
    assert.equal(request.headers["x-relayforge-cycle"], "1");
    response.writeHead(202); response.write("a".repeat(1024 * 1024));
  });
  const port = await listen(server, context);
  const transport = new LiveTransport({
    policy, resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: (options, callback) => {
      assert.equal(options.agent, false);
      assert.equal((options as { servername?: string }).servername, "hooks.relayforge.test");
      assert.equal((options as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
      options.lookup!("hooks.relayforge.test", { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]); });
      return httpsRequest({ ...options, port, ca: fixture.cert, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback);
    },
  });
  const result = await transport.send(delivery);
  assert.equal(result.statusCode, 202);
  assert.equal(result.error, null);
  assert.ok(result.durationMs < LIVE_DEADLINE_MS);
  assert.equal(received, true);
  assert.equal("body" in result, false);
});

test("redirects are terminal and untrusted TLS certificates are rejected", async (context) => {
  const fixture = createTlsFixture();
  let requests = 0;
  const server = createServer(fixture, (_request, response) => { requests++; response.writeHead(302, { Location: "http://127.0.0.1/private" }); response.end(); });
  const port = await listen(server, context);
  const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
  const trusted = new LiveTransport({ policy, resolve, request: (options, callback) => httpsRequest({ ...options, port, ca: fixture.cert, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback) });
  const redirected = await trusted.send(delivery);
  assert.equal(redirected.statusCode, 302);
  assert.equal(isRetryableTransportResult(redirected), false);
  assert.equal(requests, 1);
  const untrusted = new LiveTransport({ policy, resolve, request: (options, callback) => httpsRequest({ ...options, port, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback) });
  const rejected = await untrusted.send(delivery);
  assert.equal(rejected.statusCode, null);
  assert.equal(rejected.failureCode, "tls_failed");
  assert.equal(requests, 1);
  const mismatched = new LiveTransport({ policy, resolve, request: (options, callback) => httpsRequest({ ...options, port, ca: fixture.cert, servername: "other.relayforge.test", lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback) });
  assert.equal((await mismatched.send(delivery)).failureCode, "tls_failed");
  assert.equal(requests, 1);
});

test("reference deduplication survives reopening its separate receiver database", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-reference-restart-"));
  const filename = join(directory, "receiver.sqlite");
  const secret = randomBytes(32);
  const configuration: ReferenceConfiguration = { mode: "lose-first-ack", connections: [{ endpointId: "connection-one", keys: [{ keyId: "key-one", secret: secret.toString("base64url") }] }] };
  const servers: Server[] = [];
  const databases: DatabaseSync[] = [];
  context.after(async () => {
    for (const server of servers) if (server.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
    for (const database of databases) if (database.isOpen) database.close();
    rmSync(directory, { recursive: true });
  });
  const start = async () => {
    const database = new DatabaseSync(filename);
    databases.push(database);
    const server = createReferenceReceiver({ database, readConfiguration: () => configuration });
    servers.push(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    const transport = new LiveTransport({ policy: { allowedHosts: [], referenceEnabled: true }, request: (options, callback) => httpRequest({ ...options, port: address.port }, callback) });
    return { database, server, transport };
  };
  const send = (transport: LiveTransport, attempt: number) => {
    const timestamp = Date.now();
    const body = JSON.stringify({ eventId: "event-one", eventType: "x", payload: { amount: 42 }, attempt, cycle: 1, createdAt: 1_800_000_000_000 });
    return transport.send({ ...delivery, transport: "reference", destinationUrl: null, timestamp, body, signatures: [{ keyId: "key-one", signature: createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex") }] });
  };
  const first = await start();
  assert.equal((await send(first.transport, 1)).failureCode, "network_error");
  const closed = once(first.server, "close"); first.server.close(); first.server.closeAllConnections(); await closed;
  first.database.close();
  const second = await start();
  assert.equal((await send(second.transport, 2)).statusCode, 200);
  assert.equal((second.database.prepare("SELECT COUNT(*) AS count FROM effects").get() as { count: number }).count, 1);
  assert.equal((second.database.prepare("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count, 2);
});

test("the total deadline includes DNS and response headers without synthetic HTTP statuses", { timeout: 8_000 }, async (context) => {
  const fixture = createTlsFixture();
  const server = createServer(fixture, () => undefined);
  const port = await listen(server, context);
  let lateRequest = false;
  const dnsTimeout = new LiveTransport({ policy, resolve: (_name, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), request: () => { lateRequest = true; throw new Error("late_request"); } });
  const headerTimeout = new LiveTransport({ policy, resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: (options, callback) => httpsRequest({ ...options, port, ca: fixture.cert, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback) });
  for (const result of await Promise.all([dnsTimeout.send(delivery), headerTimeout.send(delivery)])) {
    assert.equal(result.failureCode, "timeout");
    assert.equal(result.statusCode, null);
    assert.ok(result.durationMs >= 4_900 && result.durationMs < 6_000);
  }
  assert.equal(lateRequest, false);
});

test("response headers are bounded and Retry-After parsing rejects unsafe dates and long waits", async (context) => {
  const fixture = createTlsFixture();
  const server = createServer(fixture, (_request, response) => { response.writeHead(200, { "X-Large": "a".repeat(10_000) }); response.end(); });
  const port = await listen(server, context);
  const transport = new LiveTransport({ policy, resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: (options, callback) => httpsRequest({ ...options, port, ca: fixture.cert, lookup: (_name, opts, done) => opts.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4) }, callback) });
  assert.equal((await transport.send(delivery)).failureCode, "response_headers_too_large");
  const now = Date.UTC(2026, 9, 14, 12);
  assert.equal(parseRetryAfter("120", now), 120_000);
  assert.equal(parseRetryAfter(new Date(now + 60_000).toUTCString(), now), 60_000);
  assert.equal(parseRetryAfter("86400", now), 86_400_000);
  for (const value of ["86401", "-1", "1.5", "Infinity", "1e2", "Wed, 31 Feb 2026 12:00:00 GMT", "Tue, 14 Oct 2026 12:01:00 GMT", "2026-10-14T12:01:00Z"]) assert.equal(parseRetryAfter(value, now), null, value);
  const result: TransportResult = { statusCode: 429, error: "rejected", failureCode: "http_rejected", durationMs: 1, retryAfterMs: 120_000 };
  assert.equal(isRetryableTransportResult(result), true);
  assert.equal(isRetryableTransportResult({ ...result, statusCode: 401 }), false);
  assert.equal(isRetryableTransportResult({ ...result, statusCode: 503 }), true);
});

test("independent reference receiver commits one effect across a lost acknowledgement and replay", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const secret = randomBytes(32);
  let configuration: ReferenceConfiguration = { mode: "lose-first-ack", connections: [{ endpointId: "connection-one", keys: [{ keyId: "key-one", secret: secret.toString("base64url") }] }] };
  const server = createReferenceReceiver({ database, readConfiguration: () => configuration });
  const port = await listen(server, context);
  const transport = new LiveTransport({ policy: { allowedHosts: [], referenceEnabled: true }, request: (options, callback) => httpRequest({ ...options, port }, callback) });
  const send = (attempt: number, cycle = 1, signWith = secret, keyId = "key-one") => {
    const timestamp = Date.now();
    const body = JSON.stringify({ eventId: "event-one", eventType: "invoice.paid", payload: { amount: 42 }, attempt, cycle, createdAt: 1_800_000_000_000 });
    return transport.send({ ...delivery, transport: "reference", destinationUrl: null, body, timestamp, cycle, signatures: [{ keyId, signature: createHmac("sha256", signWith).update(`${timestamp}.${body}`).digest("hex") }] });
  };
  const lost = await send(1);
  assert.equal(lost.statusCode, null);
  assert.equal(lost.failureCode, "network_error");
  assert.equal((await send(2)).statusCode, 200);
  assert.equal((await send(1, 2)).statusCode, 200);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM effects").get() as { count: number }).count, 1);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count, 3);
  assert.equal((await send(2, 2, randomBytes(32))).statusCode, 401);
  configuration = { ...configuration, mode: "failing" };
  assert.equal((await send(3, 2)).statusCode, 503);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM effects").get() as { count: number }).count, 1);
  const replacement = randomBytes(32);
  configuration = { mode: "healthy", connections: [{ endpointId: "connection-one", keys: [{ keyId: "key-one", secret: secret.toString("base64url"), expiresAt: Date.now() - 1 }, { keyId: "key-two", secret: replacement.toString("base64url") }] }] };
  assert.equal((await send(4, 2)).statusCode, 401);
  assert.equal((await send(4, 2, replacement, "key-two")).statusCode, 200);
});

test("reference signing configuration validates keys and bounded connection identities", () => {
  const valid = { mode: "healthy", connections: [{ endpointId: "one", keys: [{ keyId: "key-one", secret: randomBytes(32).toString("base64url") }] }] };
  assert.deepEqual(parseReferenceConfiguration(valid), valid);
  for (const value of [{ ...valid, mode: "unknown" }, { ...valid, connections: [valid.connections[0], valid.connections[0]] }, { mode: "healthy", connections: [{ endpointId: "../one", keys: valid.connections[0].keys }] }, { mode: "healthy", connections: [{ endpointId: "one", keys: [{ keyId: "key", secret: "x".repeat(43) }] }] }]) assert.throws(() => parseReferenceConfiguration(value));
});
