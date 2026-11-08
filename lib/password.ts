import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Salted scrypt hash in the form `salt:key` (hex). Plain-text passwords are never stored. */
export function hash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}

export function verify(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!/^[0-9a-f]{32}$/.test(salt || "") || !/^[0-9a-f]{128}$/.test(key || ""))
    return false;
  return timingSafeEqual(
    Buffer.from(key, "hex"),
    scryptSync(password, salt, 64),
  );
}
