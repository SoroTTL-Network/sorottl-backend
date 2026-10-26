import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Safety and Non-Custodial Boundary Audit", () => {
  const srcDir = path.resolve(__dirname, "../../src");

  function getAllFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getAllFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allSourceFiles = getAllFiles(srcDir);

  it("ensures source files exist to audit", () => {
    expect(allSourceFiles.length).toBeGreaterThan(0);
  });

  it("strictly forbids transaction signing and submission methods", () => {
    // Prohibited patterns in keeper/monitoring codebase
    const forbiddenPatterns = [
      /\.sign\s*\(/i,
      /\.signAuthEntry\s*\(/i,
      /sendTransaction\s*\(/i,
      /submitTransaction\s*\(/i,
      /Keypair\.fromSecret/i,
      /Keypair\.fromRawEd25519Seed/i,
      /SECRET_KEY/i,
      /PRIVATE_KEY/i,
    ];

    for (const filePath of allSourceFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const pattern of forbiddenPatterns) {
        const match = content.match(pattern);
        if (match) {
          // Check if it's merely inside comments, redact rules, or type definitions
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (pattern.test(line)) {
              const isCommentOrRedact =
                line.trim().startsWith("//") ||
                line.trim().startsWith("*") ||
                line.includes("redact") ||
                line.includes("SENSITIVE_KEYS") ||
                filePath.endsWith("logger.ts") ||
                line.includes("STRICT SAFETY BOUNDARY");
              expect(
                isCommentOrRedact,
                `Found prohibited operation pattern "${pattern}" in ${path.relative(srcDir, filePath)}:${i + 1} -> ${line.trim()}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it("verifies redacting logger covers secret and credential keywords", () => {
    const loggerPath = path.join(srcDir, "logging/logger.ts");
    const content = fs.readFileSync(loggerPath, "utf-8");

    expect(content).toContain("secret");
    expect(content).toContain("privateKey");
    expect(content).toContain("seedPhrase");
    expect(content).toContain("token");
    expect(content).toContain("password");
  });
});
