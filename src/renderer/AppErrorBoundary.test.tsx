import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

afterEach(() => vi.restoreAllMocks());
describe("interface recovery", () => {
  it("catches a render failure and remounts after the user repairs the view", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Screen() {
      if (broken) throw new Error("invalid cached panel");
      return <p>聊天已恢复</p>;
    }
    const recover = vi.fn(() => { broken = false; });
    render(<AppErrorBoundary onRecover={recover}><Screen /></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("界面暂时无法显示");
    fireEvent.click(screen.getByRole("button", { name: "恢复界面" }));
    expect(screen.getByText("聊天已恢复")).toBeInTheDocument();
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
