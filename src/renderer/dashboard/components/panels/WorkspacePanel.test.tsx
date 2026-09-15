import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import { WorkspacePanel } from "./WorkspacePanel";

describe("recent workspaces", () => {
  beforeEach(() => useAppStore.getState().resetStore());

  it("retains saved spaces and session directories while deduplicating the current path", () => {
    useAppStore.setState({
      workspacePath: "D:/work/project",
      recentWorkspaces: [{ name: "最近项目", path: "D:\\work\\project\\", lastOpenedAt: "now" }],
      webUiOverview: { projects: [{ id: "legacy", name: "已有项目", sessionCount: 1 }], spaces: [{ id: "saved", name: "收藏目录", path: "D:/work/saved" }] } as any,
      sessions: [{ id: "s1", title: "会话", workspacePath: "D:/work/from-session", sessionFilesPath: "D:/data/session", status: "idle", createdAt: "now", updatedAt: "now" }],
    });
    const onSelectWorkspace = vi.fn();
    render(<WorkspacePanel onPickWorkspace={vi.fn()} onSelectWorkspace={onSelectWorkspace} />);
    expect(screen.queryByText("最近项目")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /收藏目录/ }));
    expect(onSelectWorkspace).toHaveBeenCalledWith("D:/work/saved");
    expect(screen.getByRole("button", { name: /from-session/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已有项目 · 1", hidden: true }));
    expect(useAppStore.getState().selectedProjectId).toBe("legacy");
    expect(useAppStore.getState().activePanel).toBe("chat");
  });
});
