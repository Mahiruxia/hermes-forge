import type { HermesWebUiOverview } from "../shared/types";
import { useAppStore } from "./store";

type OverviewSection = "skills" | "memory" | "profiles" | "crons";

/** Fetch only the data needed by the currently open panel. */
export async function refreshOverviewSection(section: OverviewSection) {
  const client = window.workbenchClient;
  const items = await ({
    skills: () => client.listSkills(),
    memory: () => client.listMemoryFiles(),
    profiles: () => client.listProfiles(),
    crons: () => client.listCronJobs(),
  }[section])();
  const store = useAppStore.getState();
  const current: HermesWebUiOverview = store.webUiOverview ?? {
    settings: { theme: "green-light", language: "zh", sendKey: "enter", sendKeyHintDismissed: true, showUsage: false, showCliSessions: true },
    projects: [], spaces: [], skills: [], memory: [], profiles: [], crons: [], slashCommands: [],
  };
  store.setWebUiOverview({ ...current, [section]: items });
}
