import { promises as fs } from "node:fs";

import { NextRequest, NextResponse } from "next/server";
import { resolveWorkspacePath, sanitizeWorkspacePath } from "@/lib/workspace/shell";

export async function GET(request: NextRequest) {
  const relPath = request.nextUrl.searchParams.get("path") ?? "";
  const safePath = sanitizeWorkspacePath(relPath);

  if (!safePath) {
    return NextResponse.json({ message: "Invalid file path." }, { status: 400 });
  }

  const absolutePath = resolveWorkspacePath(safePath);
  if (!absolutePath) {
    return NextResponse.json({ message: "Path is outside workspace." }, { status: 400 });
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return NextResponse.json({ message: "Path is not a file." }, { status: 400 });
    }

    const content = await fs.readFile(absolutePath, "utf8");
    return NextResponse.json({ path: safePath, content }, { status: 200 });
  } catch {
    return NextResponse.json({ message: "File not found or unreadable." }, { status: 404 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as { path?: string; content?: string };
    const safePath = sanitizeWorkspacePath(payload.path ?? "");

    if (!safePath || typeof payload.content !== "string") {
      return NextResponse.json({ message: "Invalid file write payload." }, { status: 400 });
    }

    const absolutePath = resolveWorkspacePath(safePath);
    if (!absolutePath) {
      return NextResponse.json({ message: "Path is outside workspace." }, { status: 400 });
    }

    await fs.writeFile(absolutePath, payload.content, "utf8");
    return NextResponse.json({ path: safePath, saved: true }, { status: 200 });
  } catch {
    return NextResponse.json({ message: "Failed to save file." }, { status: 500 });
  }
}
