import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LATEST_YML_PATTERN =
  /^version: ([^\r\n]+)\nfiles:\n  - url: ([^\r\n]+)\n    sha512: ([A-Za-z0-9+/]{86}==)\n    size: (0|[1-9][0-9]*)\n  - url: ([^\r\n]+)\n    sha512: ([A-Za-z0-9+/]{86}==)\n    size: (0|[1-9][0-9]*)\npath: ([^\r\n]+)\nsha512: ([A-Za-z0-9+/]{86}==)\n(?:releaseDate: [^\r\n]*\n)?$/;

function invalid(message) {
  return { ok: false, message: `Invalid latest.yml: ${message}` };
}

function isCanonicalSha512(digest) {
  const decoded = Buffer.from(digest, "base64");
  return decoded.length === 64 && decoded.toString("base64") === digest;
}

function sha512File(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

/**
 * Validate only the exact latest.yml shape emitted by merge-windows-latest-yml.
 * @param {{ metadata: string, version: string, distDir: string }} options
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function verifyWindowsLatestYml(options) {
  const match = LATEST_YML_PATTERN.exec(options.metadata);
  if (match === null) {
    return invalid("metadata does not match the supported schema");
  }

  const [
    ,
    metadataVersion,
    firstPath,
    firstDigest,
    firstSizeText,
    secondPath,
    secondDigest,
    secondSizeText,
    primaryPath,
    primaryDigest,
  ] = match;
  if (metadataVersion !== options.version) {
    return invalid(`version must be ${options.version}`);
  }

  const records = [
    { path: firstPath, digest: firstDigest, sizeText: firstSizeText },
    { path: secondPath, digest: secondDigest, sizeText: secondSizeText },
  ];
  const x64Path = `GogMeet-${options.version}-x64.exe`;
  const arm64Path = `GogMeet-${options.version}-arm64.exe`;
  const x64Record = records.find((record) => record.path === x64Path);
  const arm64Record = records.find((record) => record.path === arm64Path);
  if (x64Record === undefined || arm64Record === undefined) {
    return invalid("files must contain exactly the x64 and arm64 NSIS artifacts");
  }

  for (const record of records) {
    const size = Number(record.sizeText);
    if (!Number.isSafeInteger(size)) {
      return invalid(`size for ${record.path} must be a safe integer`);
    }
    if (!isCanonicalSha512(record.digest)) {
      return invalid(`sha512 for ${record.path} must be canonical base64`);
    }

    const filePath = join(options.distDir, record.path);
    const diskSize = statSync(filePath).size;
    if (size !== diskSize) {
      return invalid(`size for ${record.path} does not match disk`);
    }
    if (record.digest !== sha512File(filePath)) {
      return invalid(`sha512 for ${record.path} does not match disk`);
    }
  }

  if (primaryPath !== x64Path) {
    return invalid("top-level path must identify the x64 NSIS artifact");
  }
  if (!isCanonicalSha512(primaryDigest)) {
    return invalid("top-level sha512 must be canonical base64");
  }
  if (primaryDigest !== x64Record.digest) {
    return invalid("top-level sha512 must match the x64 file record");
  }
  if (primaryDigest !== sha512File(join(options.distDir, x64Path))) {
    return invalid("top-level sha512 does not match disk");
  }

  return { ok: true };
}
