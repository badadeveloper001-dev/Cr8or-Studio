import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";

const createSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().default(""),
  framework: z.string().default("Next.js"),
  language: z.string().default("TypeScript"),
  repository: z.string().optional(),
});

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, description: true, framework: true, language: true, createdAt: true },
    });
    return NextResponse.json(projects);
  } catch {
    return NextResponse.json({ message: "Failed to list projects." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const raw = await request.json();
    const data = createSchema.parse(raw);
    const project = await prisma.project.create({ data });
    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ message: "Invalid project data.", issues: err.issues }, { status: 400 });
    }
    return NextResponse.json({ message: "Failed to create project." }, { status: 500 });
  }
}
