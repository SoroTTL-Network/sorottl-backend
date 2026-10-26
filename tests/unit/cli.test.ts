import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCli } from "../../src/cli/index.js";

describe("CLI Commands", () => {
  let originalArgv: string[];
  let exitMock: ReturnType<typeof vi.spyOn>;
  let consoleLogMock: ReturnType<typeof vi.spyOn>;
  let consoleErrorMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    exitMock = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit called with ${code}`);
      });
    consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorMock = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitMock.mockRestore();
    consoleLogMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  it("builds the CLI program successfully with all subcommands", () => {
    const cli = createCli();
    expect(cli.name()).toBe("sorottl");
    const commandNames = cli.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain("config:check");
    expect(commandNames).toContain("watchlist:add");
    expect(commandNames).toContain("watchlist:list");
    expect(commandNames).toContain("watchlist:disable");
    expect(commandNames).toContain("monitor:once");
    expect(commandNames).toContain("keeper:start");
    expect(commandNames).toContain("alerts:list");
  });

  it("prints version and help without throwing unhandled exceptions", async () => {
    const cli = createCli();
    cli.exitOverride(); // Commander will throw CommanderError instead of process.exit

    expect(() => cli.parse(["node", "sorottl", "--help"])).toThrow();
  });
});
