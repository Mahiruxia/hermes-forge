import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./SessionSidebar";
import { useAppStore } from "../../store";

describe("SessionSidebar", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
    useAppStore.setState({
      activeSessionId: "session-today",
      runtimeConfig: {
        defaultModelProfileId: "default",
        modelProfiles: [{ id: "default", provider: "custom", model: "gpt-5.4", baseUrl: "http://127.0.0.1:1234/v1" }],
        updateSources: {},
      },
      sessions: [
        {
          id: "session-pinned",
          title: "收藏会话",
          status: "idle",
          pinned: true,
          sessionFilesPath: "D:/temp/pinned",
          createdAt: "2026-04-21T10:00:00.000Z",
          updatedAt: new Date().toISOString(),
        },
        {
          id: "session-archived",
          title: "曾被归档的会话",
          status: "archived",
          sessionFilesPath: "D:/temp/archived",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "session-today",
          title: "今天会话",
          status: "idle",
          sessionFilesPath: "D:/temp/today",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
  });

  function renderSidebar() {
    const callbacks = {
      onCreateSession: vi.fn(),
      onSelectSession: vi.fn(),
      onDeleteSession: vi.fn(),
      onDuplicateSession: vi.fn(),
      onExportSession: vi.fn(),
      onImportSession: vi.fn(),
      onUpdateSessionMeta: vi.fn(),
      onCollapse: vi.fn(),
    };
    render(
      <SessionSidebar
        {...callbacks}
      />,
    );
    return callbacks;
  }

  it("shows recent sessions by default", () => {
    renderSidebar();

    expect(screen.getAllByText("最近").length).toBeGreaterThan(0);
    expect(screen.getByText("今天会话")).toBeInTheDocument();
    expect(screen.getByText("收藏会话")).toBeInTheDocument();
    expect(screen.getByText("曾被归档的会话")).toBeInTheDocument();
    expect(screen.queryByTitle("归档")).toBeNull();
    expect(document.querySelector("aside")).toHaveClass("w-full");
    expect(document.querySelector("aside")).toHaveClass("h-full");
    expect(document.querySelector("aside")).toHaveClass("min-h-0");
    expect(screen.queryByText("Hermes · 已完成")).toBeNull();
    expect(screen.getAllByText("Hermes · gpt-5.4").length).toBeGreaterThan(0);
    const todayItem = screen.getByText("今天会话").closest(".hermes-session-item");
    expect(todayItem).toHaveClass("bg-[var(--hermes-primary-soft)]");
    expect(todayItem?.querySelector('[title="删除"]')?.parentElement).toHaveClass("opacity-0");
    expect(screen.getByTestId("session-sidebar-footer")).toHaveClass("mt-auto");
  });

  it("calls onCollapse from the header collapse button", () => {
    const callbacks = renderSidebar();

    expect(screen.getByRole("button", { name: "隐藏历史会话栏" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "隐藏历史会话栏" }));

    expect(callbacks.onCollapse).toHaveBeenCalledTimes(1);
  });

  it("switches to favorite sessions", () => {
    renderSidebar();

    fireEvent.click(screen.getAllByRole("button", { name: "收藏" })[0]);

    expect(screen.getByText("收藏会话")).toBeInTheDocument();
    expect(screen.queryByText("今天会话")).toBeNull();
  });

  it("keeps session selection and destructive actions reachable", () => {
    const callbacks = renderSidebar();
    const todayItem = screen.getByText("今天会话").closest(".hermes-session-item");

    fireEvent.click(screen.getByRole("button", { name: /今天会话/ }));
    fireEvent.click(within(todayItem as HTMLElement).getByRole("button", { name: "删除" }));

    expect(callbacks.onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-today" }));
    expect(callbacks.onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-today" }));
  });
});
