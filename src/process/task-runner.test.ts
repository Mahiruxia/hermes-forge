import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractInlineImagePaths, mimeTypeForImagePath, resolveInlineImageAttachments } from "./task-runner";
import type { SessionAttachment } from "../shared/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("task-runner inline image paths", () => {
  it("extracts quoted Windows image paths without treating plain text as attachments", () => {
    const paths = extractInlineImagePaths('请问"C:\\Users\\xia\\Desktop\\ScreenShot_2026-04-21_122543_618.png"是什么内容');

    expect(paths).toEqual(["C:\\Users\\xia\\Desktop\\ScreenShot_2026-04-21_122543_618.png"]);
  });

  it("deduplicates existing attachments and infers image metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-inline-image-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "screen shot.PNG");
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const existing: SessionAttachment[] = [
      {
        id: "existing",
        name: "screen shot.PNG",
        path: imagePath,
        originalPath: imagePath,
        kind: "image",
        mimeType: "image/png",
        size: 4,
        createdAt: "2026-04-21T00:00:00.000Z",
      },
    ];

    const attachments = await resolveInlineImageAttachments(`看一下 "${imagePath}"`, existing);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toBe(existing[0]);
  });

  it("promotes an accessible Windows image path into an image attachment", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-inline-image-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "desktop-capture.jpg");
    await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff]));

    const attachments = await resolveInlineImageAttachments(`帮我识别 '${imagePath}'`, []);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: "desktop-capture.jpg",
      path: imagePath,
      originalPath: imagePath,
      kind: "image",
      mimeType: "image/jpeg",
      size: 3,
    });
  });

  it("ignores unsupported or inaccessible paths safely", async () => {
    const attachments = await resolveInlineImageAttachments("打开 C:\\Users\\xia\\Desktop\\notes.txt 和 C:\\missing\\ghost.png", []);

    expect(attachments).toEqual([]);
  });

  it("maps common image extensions to MIME types", () => {
    expect(mimeTypeForImagePath("a.png")).toBe("image/png");
    expect(mimeTypeForImagePath("a.jpeg")).toBe("image/jpeg");
    expect(mimeTypeForImagePath("a.webp")).toBe("image/webp");
    expect(mimeTypeForImagePath("a.bmp")).toBe("image/bmp");
    expect(mimeTypeForImagePath("a.txt")).toBeUndefined();
  });
});
