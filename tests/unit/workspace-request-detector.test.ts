import { describe, expect, it } from "vitest";

import { detectWorkspaceRequest } from "@/lib/workspace/workspace-request-detector";

describe("detectWorkspaceRequest", () => {
  describe("read_file", () => {
    it("detects 'Read package.json'", () => {
      const result = detectWorkspaceRequest("Read package.json");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("package.json");
    });

    it("detects 'read package.json and tell me the project name'", () => {
      const result = detectWorkspaceRequest("Read package.json and tell me the project name");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("package.json");
    });

    it("detects 'open src/app/page.tsx'", () => {
      const result = detectWorkspaceRequest("open src/app/page.tsx");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("src/app/page.tsx");
    });

    it("detects 'show me src/lib/utils.ts'", () => {
      const result = detectWorkspaceRequest("show me src/lib/utils.ts");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("src/lib/utils.ts");
    });

    it("detects 'cat README.md'", () => {
      const result = detectWorkspaceRequest("cat README.md");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("README.md");
    });

    it("detects 'what is in src/app/'", () => {
      const result = detectWorkspaceRequest("what is in src/app/");
      expect(result.type).toBe("read_file");
      expect(result.path).toBe("src/app/");
    });
  });

  describe("list_files", () => {
    it("detects 'list files'", () => {
      const result = detectWorkspaceRequest("list files");
      expect(result.type).toBe("list_files");
    });

    it("detects 'list the project files'", () => {
      const result = detectWorkspaceRequest("list the project files");
      expect(result.type).toBe("list_files");
    });

    it("detects 'show files'", () => {
      const result = detectWorkspaceRequest("show files");
      expect(result.type).toBe("list_files");
    });

    it("detects 'show project root'", () => {
      const result = detectWorkspaceRequest("show project root");
      expect(result.type).toBe("list_files");
    });

    it("detects 'files'", () => {
      const result = detectWorkspaceRequest("files");
      expect(result.type).toBe("list_files");
    });

    it("detects 'project files'", () => {
      const result = detectWorkspaceRequest("project files");
      expect(result.type).toBe("list_files");
    });
  });

  describe("git_status", () => {
    it("detects 'git status'", () => {
      const result = detectWorkspaceRequest("git status");
      expect(result.type).toBe("git_status");
    });

    it("detects 'show me git status'", () => {
      const result = detectWorkspaceRequest("show me git status");
      expect(result.type).toBe("git_status");
    });

    it("detects 'what changed'", () => {
      const result = detectWorkspaceRequest("what changed");
      expect(result.type).toBe("git_status");
    });

    it("detects 'changes'", () => {
      const result = detectWorkspaceRequest("changes");
      expect(result.type).toBe("git_status");
    });
  });

  describe("git_diff", () => {
    it("detects 'git diff'", () => {
      const result = detectWorkspaceRequest("git diff");
      expect(result.type).toBe("git_diff");
    });

    it("detects 'show me the diff'", () => {
      const result = detectWorkspaceRequest("show me the diff");
      expect(result.type).toBe("git_diff");
    });

    it("detects 'show changes'", () => {
      const result = detectWorkspaceRequest("show changes");
      expect(result.type).toBe("git_diff");
    });
  });

  describe("inspect_project", () => {
    it("detects 'inspect the project structure'", () => {
      const result = detectWorkspaceRequest("inspect the project structure");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'inspect the project'", () => {
      const result = detectWorkspaceRequest("inspect the project");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'analyze the codebase'", () => {
      const result = detectWorkspaceRequest("analyze the codebase");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'show me the project structure'", () => {
      const result = detectWorkspaceRequest("show me the project structure");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'tell me about the project structure'", () => {
      const result = detectWorkspaceRequest("tell me about the project structure");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'what are the main folders'", () => {
      const result = detectWorkspaceRequest("what are the main folders");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'where does the app live'", () => {
      const result = detectWorkspaceRequest("where does the app live");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'where does supabase live'", () => {
      const result = detectWorkspaceRequest("where does supabase live");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'inspect the source directories'", () => {
      const result = detectWorkspaceRequest("inspect the source directories");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'explore the repository'", () => {
      const result = detectWorkspaceRequest("explore the repository");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'project architecture'", () => {
      const result = detectWorkspaceRequest("project architecture");
      expect(result.type).toBe("inspect_project");
    });

    it("detects 'show project architecture'", () => {
      const result = detectWorkspaceRequest("show project architecture");
      expect(result.type).toBe("inspect_project");
    });

    it("does not detect 'fix the project structure'", () => {
      const result = detectWorkspaceRequest("fix the project structure");
      expect(result.type).toBeNull();
    });

    it("does not detect 'build the project'", () => {
      const result = detectWorkspaceRequest("build the project");
      expect(result.type).toBeNull();
    });
  });

  describe("non-read operations", () => {
    it("ignores 'fix the navbar'", () => {
      const result = detectWorkspaceRequest("fix the navbar");
      expect(result.type).toBeNull();
    });

    it("ignores 'edit package.json'", () => {
      const result = detectWorkspaceRequest("edit package.json");
      expect(result.type).toBeNull();
    });

    it("ignores 'create a new file'", () => {
      const result = detectWorkspaceRequest("create a new file");
      expect(result.type).toBeNull();
    });

    it("ignores 'build the project'", () => {
      const result = detectWorkspaceRequest("build the project");
      expect(result.type).toBeNull();
    });

    it("ignores 'implement the feature'", () => {
      const result = detectWorkspaceRequest("implement the feature");
      expect(result.type).toBeNull();
    });

    it("ignores 'What is React?'", () => {
      const result = detectWorkspaceRequest("What is React?");
      expect(result.type).toBeNull();
    });

    it("ignores 'refactor the component'", () => {
      const result = detectWorkspaceRequest("refactor the component");
      expect(result.type).toBeNull();
    });
  });

  describe("path normalization", () => {
    it("normalizes ./src/app.tsx to src/app.tsx", () => {
      const result = detectWorkspaceRequest("read ./src/app.tsx");
      expect(result.path).toBe("src/app.tsx");
    });

    it("removes quotes from paths", () => {
      const result = detectWorkspaceRequest("read 'package.json'");
      expect(result.path).toBe("package.json");
    });

    it("handles double quotes", () => {
      const result = detectWorkspaceRequest('read "src/app.tsx"');
      expect(result.path).toBe("src/app.tsx");
    });
  });
});
