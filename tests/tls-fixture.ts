import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

function der(tag: number, bytes: Buffer): Buffer {
  const length = bytes.length < 128
    ? Buffer.from([bytes.length])
    : (() => { const digits: number[] = []; let remaining = bytes.length; while (remaining) { digits.unshift(remaining & 255); remaining >>>= 8; } return Buffer.from([128 | digits.length, ...digits]); })();
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
}
const sequence = (...bytes: Buffer[]) => der(0x30, Buffer.concat(bytes));
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const integer = (bytes: Buffer) => der(0x02, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const pem = (label: string, bytes: Buffer) => `-----BEGIN ${label}-----\n${bytes.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** Runtime-only test CA material is never a production key or a trust-store change. */
export function createTlsFixture(host = "hooks.relayforge.test"): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = sequence(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 11]), der(5, Buffer.alloc(0)));
  const name = sequence(der(0x31, sequence(oid([0x55, 4, 3]), der(0x0c, Buffer.from(host)))));
  const extensions = der(0xa3, sequence(
    sequence(oid([0x55, 0x1d, 0x13]), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
    sequence(oid([0x55, 0x1d, 0x11]), der(4, sequence(der(0x82, Buffer.from(host))))),
  ));
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))), integer(randomBytes(8)), algorithm, name,
    sequence(der(0x17, Buffer.from("200101000000Z")), der(0x17, Buffer.from("490101000000Z"))),
    name, publicKey.export({ type: "spki", format: "der" }), extensions,
  );
  const signature = sign("RSA-SHA256", tbs, privateKey);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", sequence(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), signature])))),
  };
}
