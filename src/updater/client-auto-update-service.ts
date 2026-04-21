import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { IpcChannels } from "../shared/ipc";
import type { ClientUpdateEvent } from "../shared/types";

export class ClientAutoUpdateService {
  private lastEvent: ClientUpdateEvent;
  private checking = false;

  constructor(private readonly getMainWindow: () => BrowserWindow | undefined) {
    this.lastEvent = this.event("idle", "自动更新已就绪。");
    this.configure();
  }

  scheduleStartupCheck(delayMs = 5000) {
    setTimeout(() => {
      void this.checkForUpdates(false);
    }, delayMs);
  }

  async checkForUpdates(manual = true): Promise<ClientUpdateEvent> {
    if (this.checking) {
      return this.lastEvent;
    }
    this.checking = true;
    try {
      this.publish(this.event("checking", manual ? "正在手动检查客户端更新..." : "正在后台检查客户端更新...", { manual }));
      await autoUpdater.checkForUpdatesAndNotify();
      return this.lastEvent;
    } catch (error) {
      const message = error instanceof Error ? error.message : "检查更新失败。";
      this.publish(this.event("error", `客户端更新检查失败：${message}`, { manual }));
      return this.lastEvent;
    } finally {
      this.checking = false;
    }
  }

  snapshot() {
    return this.lastEvent;
  }

  private configure() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.publish(this.event("checking", "正在检查客户端更新..."));
    });

    autoUpdater.on("update-available", (info) => {
      this.publish(this.event("available", `发现新版本 ${info.version}，正在后台下载。`, {
        latestVersion: info.version,
      }));
    });

    autoUpdater.on("update-not-available", (info) => {
      this.publish(this.event("not-available", "当前已经是最新版本。", {
        latestVersion: info.version,
      }));
    });

    autoUpdater.on("download-progress", (progress) => {
      this.publish(this.event("downloading", `正在下载更新：${Math.round(progress.percent)}%`, {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      }));
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.publish(this.event("downloaded", `新版本 ${info.version} 已准备就绪。`, {
        latestVersion: info.version,
        percent: 100,
      }));
      void this.promptRestart(info);
    });

    autoUpdater.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.publish(this.event("error", `自动更新失败：${message}`));
    });
  }

  private async promptRestart(info: UpdateInfo) {
    const owner = this.getMainWindow();
    const result = owner
      ? await dialog.showMessageBox(owner, restartDialogOptions(info.version))
      : await dialog.showMessageBox(restartDialogOptions(info.version));
    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  private event(
    status: ClientUpdateEvent["status"],
    message: string,
    patch: Partial<ClientUpdateEvent> = {},
  ): ClientUpdateEvent {
    return {
      status,
      message,
      currentVersion: app.getVersion(),
      at: new Date().toISOString(),
      ...patch,
    };
  }

  private publish(event: ClientUpdateEvent) {
    this.lastEvent = event;
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IpcChannels.clientUpdateEvent, event);
  }
}

function restartDialogOptions(version: string) {
  return {
    type: "info" as const,
    buttons: ["立即重启更新", "稍后"],
    defaultId: 0,
    cancelId: 1,
    title: "Hermes Forge 更新已下载",
    message: `新版本 ${version} 已准备就绪，是否立即重启应用完成更新？`,
    detail: "如果选择稍后，更新会在下次退出应用时自动安装。",
  };
}
