import type { RuntimeConfigStore } from "../main/runtime-config";
import type { SetupDependencyRepairId } from "../shared/types";
import type { InstallStrategy } from "./install-strategy";
import type {
  InstallOptions,
  InstallPlan,
  InstallPublisher,
  InstallStrategyRepairResult,
  InstallStrategyResult,
  InstallStrategyUpdateResult,
} from "./install-types";

export class InstallOrchestrator {
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly nativeStrategy: InstallStrategy,
  ) {}

  async plan(options: InstallOptions = {}): Promise<InstallPlan> {
    return this.nativeStrategy.plan({ ...options, mode: "windows" });
  }

  async install(publish?: InstallPublisher, options: InstallOptions = {}): Promise<InstallStrategyResult> {
    return this.nativeStrategy.install(publish, { ...options, mode: "windows" });
  }

  async update(options: InstallOptions = {}): Promise<InstallStrategyUpdateResult> {
    return this.nativeStrategy.update();
  }

  async repairDependency(id: SetupDependencyRepairId, options: InstallOptions = {}): Promise<InstallStrategyRepairResult> {
    return this.nativeStrategy.repairDependency(id);
  }
}
