import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ClarifyRequest } from "../../../shared/types";
import { useAppStore } from "../../store";
import { NativeApprovalCard, NativeClarifyCard } from "./NativeInteractionCards";

const approval: ApprovalRequest = {
  id: "approval-1", taskRunId: "run-1", title: "允许执行命令？", command: "git status", patternKey: "git", scopeKey: "run-1",
  actionKind: "command_run", risk: "low", status: "pending", createdAt: "2026-09-15T00:00:00Z", allowedChoices: ["once", "deny"], allowEdit: false,
};
const clarify: ClarifyRequest = { id: "clarify-1", taskRunId: "run-1", sessionId: "session-1", question: "选择目标", options: ["Windows", "macOS"], status: "pending", createdAt: "2026-09-15T00:00:00Z" };

describe("native interaction cards", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
    useAppStore.setState({ pendingApprovalCards: [approval], pendingClarifyCards: [clarify], userInput: "尚未发送的草稿" });
    window.workbenchClient = { ...window.workbenchClient, respondApproval: vi.fn().mockResolvedValue({ ok: true }), respondInteraction: vi.fn().mockResolvedValue({ ok: true, message: "已回答" }) };
  });

  it("submits an immutable native approval once and resolves only after acceptance", async () => {
    let complete!: (value: { ok: boolean; message: string }) => void;
    const respond = vi.fn().mockReturnValue(new Promise(resolve => { complete = resolve; }));
    window.workbenchClient.respondApproval = respond;
    render(<NativeApprovalCard card={approval} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "本会话允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "始终允许" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ id: approval.id, choice: "once" });
    expect(useAppStore.getState().pendingApprovalCards).toHaveLength(1);
    await act(async () => complete({ ok: true, message: "已允许" }));
    expect(useAppStore.getState().pendingApprovalCards).toHaveLength(0);
    expect(useAppStore.getState().userInput).toBe("尚未发送的草稿");
  });

  it("keeps rejected approval responses pending and permits a retry", async () => {
    const respond = vi.fn().mockResolvedValueOnce({ ok: false, message: "请求已过期" }).mockResolvedValueOnce({ ok: true });
    window.workbenchClient.respondApproval = respond;
    render(<NativeApprovalCard card={approval} />);
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请求已过期");
    expect(useAppStore.getState().pendingApprovalCards).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(useAppStore.getState().pendingApprovalCards).toHaveLength(0));
    expect(respond).toHaveBeenLastCalledWith({ id: approval.id, choice: "deny" });
  });

  it("sends an edited command only for cards that allow editing", async () => {
    render(<NativeApprovalCard card={{ ...approval, allowEdit: true }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "待执行命令" }), { target: { value: "git diff" } });
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    await waitFor(() => expect(window.workbenchClient.respondApproval).toHaveBeenCalledWith({ id: approval.id, choice: "once", editedCommand: "git diff" }));
  });

  it("answers a native choice through its waiting task without replacing the draft", async () => {
    render(<NativeClarifyCard card={clarify} />);
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Windows" }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(useAppStore.getState().pendingClarifyCards).toHaveLength(0));
    expect(window.workbenchClient.respondInteraction).toHaveBeenCalledWith({ requestId: clarify.id, taskRunId: "run-1", kind: "clarify", answer: "Windows" });
    expect(useAppStore.getState().userInput).toBe("尚未发送的草稿");
  });

  it("collects multiple question answers including choices and free text", async () => {
    render(<NativeClarifyCard card={{ ...clarify, questions: [{ id: "platforms", question: "发布平台", choices: ["Windows", "macOS"], multiSelect: true }, { id: "name", question: "发布名称" }] }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Windows" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "macOS" }));
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "发布名称" }), { target: { value: "  桌面版  " } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(window.workbenchClient.respondInteraction).toHaveBeenCalledWith({ requestId: clarify.id, taskRunId: "run-1", kind: "clarify", answers: { platforms: ["Windows", "macOS"], name: "桌面版" } }));
  });

  it("keeps failed clarification pending and skips through the original task", async () => {
    const respond = vi.fn().mockResolvedValueOnce({ ok: false, message: "暂时无法提交" }).mockResolvedValueOnce({ ok: true });
    window.workbenchClient.respondInteraction = respond;
    render(<NativeClarifyCard card={{ ...clarify, options: undefined }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "选择目标" }), { target: { value: "桌面" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法提交");
    expect(useAppStore.getState().pendingClarifyCards).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => expect(useAppStore.getState().pendingClarifyCards).toHaveLength(0));
    expect(respond).toHaveBeenLastCalledWith({ requestId: clarify.id, taskRunId: "run-1", kind: "clarify", timedOut: true });
  });

  it("closes local help without sending an engine response", () => {
    render(<NativeClarifyCard card={{ ...clarify, taskRunId: undefined }} />);
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(window.workbenchClient.respondInteraction).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingClarifyCards).toHaveLength(0);
  });
});
