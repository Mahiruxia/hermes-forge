import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { IconRail } from "./IconRail";
import { useAppStore } from "../../store";

describe("IconRail", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
  });

  it("uses the Hermes purple active state for the current panel", () => {
    render(<IconRail />);

    expect(screen.getByRole("button", { name: "聊天" })).toHaveClass("bg-[var(--hermes-primary)]");
  });
});
