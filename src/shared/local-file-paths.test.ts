import { describe, expect, it } from "vitest";
import { extractInlineLocalFilePaths, looksLikeAbsoluteLocalFilePath } from "./local-file-paths";

describe("inline local file paths", () => {
  it("extracts quoted and unquoted POSIX paths", () => {
    expect(extractInlineLocalFilePaths("请看 '/Users/xia/My Project/封面图.png'")).toEqual([
      "/Users/xia/My Project/封面图.png",
    ]);
    expect(extractInlineLocalFilePaths("请看 /tmp/render output.jpg 这张图")).toEqual([
      "/tmp/render output.jpg",
    ]);
  });

  it("does not mistake web URLs for local files", () => {
    expect(extractInlineLocalFilePaths("请看 https://example.com/assets/cover.png")).toEqual([]);
  });

  it("recognizes Windows, WSL, and POSIX absolute paths", () => {
    expect(looksLikeAbsoluteLocalFilePath("C:\\Users\\xia\\cover.png")).toBe(true);
    expect(looksLikeAbsoluteLocalFilePath("\\\\wsl$\\Ubuntu\\home\\xia\\cover.png")).toBe(true);
    expect(looksLikeAbsoluteLocalFilePath("/Users/xia/cover.png")).toBe(true);
    expect(looksLikeAbsoluteLocalFilePath("assets/cover.png")).toBe(false);
  });
});
