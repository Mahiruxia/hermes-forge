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
  private maintenanceInFlight = false;
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly nativeStrategy: InstallStrategy,
  ) {}

  isBusy() { return this.maintenanceInFlight; }

  async plan(options: InstallOptions = {}): Promise<InstallPlan> {
    return this.nativeStrategy.plan(options);
  }

  async install(publish?: InstallPublisher, options: InstallOptions = {}): Promise<InstallStrategyResult> {
    return this.maintain(() => this.nativeStrategy.install(publish, options));
  }

  async cancelInstall(): Promise<{ ok: boolean; message: string }> {
    if (!this.nativeStrategy.cancelInstall) {
      return { ok: false, message: "当前安装策略不支持取消。" };
    }
    return this.nativeStrategy.cancelInstall();
  }

  async update(options: InstallOptions = {}): Promise<InstallStrategyUpdateResult> {
    return this.maintain(() => this.nativeStrategy.update());
  }

  async repairDependency(id: SetupDependencyRepairId, options: InstallOptions = {}): Promise<InstallStrategyRepairResult> {
    return this.maintain(() => this.nativeStrategy.repairDependency(id));
  }

  private async maintain<T>(action: () => Promise<T>): Promise<T> {
    if (this.maintenanceInFlight) throw new Error("Hermes 安装、升级或修复正在进行，请等待完成后重试。");
    this.maintenanceInFlight = true;
    try { return await action(); }
    finally { this.maintenanceInFlight = false; }
  }
}
