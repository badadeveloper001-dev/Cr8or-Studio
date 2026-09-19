-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeType" TEXT NOT NULL,
    "provider" TEXT,
    "providerWorkspaceId" TEXT,
    "repositoryUrl" TEXT,
    "projectName" TEXT,
    "branch" TEXT,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_projectId_key" ON "Workspace"("projectId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
