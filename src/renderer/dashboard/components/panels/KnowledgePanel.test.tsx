import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import { KnowledgePanel } from "./KnowledgePanel";

describe("knowledge panel data loading", () => {
  beforeEach(() => useAppStore.getState().resetStore());

  it("loads only the visible tab and preserves previously loaded sections", async () => {
    const skill = { id: "skill-1", name: "我的技能", path: "skills/skill-1.md", source: "local" };
    const listSkills = vi.fn().mockResolvedValue([skill]);
    const listMemoryFiles = vi.fn().mockResolvedValue([]);
    const getWebUiOverview = vi.fn();
    window.workbenchClient = { ...window.workbenchClient, listSkills, listMemoryFiles, getWebUiOverview };
    render(<KnowledgePanel />);
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(1));
    expect(listMemoryFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
    await waitFor(() => expect(listMemoryFiles).toHaveBeenCalledTimes(1));
    expect(getWebUiOverview).not.toHaveBeenCalled();
    expect(useAppStore.getState().webUiOverview?.skills).toEqual([skill]);
  });
});
