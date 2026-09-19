import path from "node:path";

export const CLOUD_REPOSITORY_ROOT = "repo";

export function cloudPath(input = "."): string {
  const relative = input.replace(/\\/g, "/");
  if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.split("/").includes("..") || relative.includes("\0")) {
    throw new Error("Path must stay inside the repository.");
  }
  const parts = relative.toLowerCase().split("/");
  if (parts.some((part) => part === ".git" || (part.startsWith(".env") && part !== ".env.example") || /^(secrets?|credentials?|id_rsa|id_ed25519|\.npmrc)$/.test(part) || /\.(pem|key)$/.test(part))) {
    throw new Error("Access to secret-sensitive paths is forbidden.");
  }
  return path.posix.join(CLOUD_REPOSITORY_ROOT, relative);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
