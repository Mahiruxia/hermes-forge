import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode; onRecover: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Hermes Forge] Interface failed:", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6" role="alert">
        <section className="max-w-lg rounded-2xl bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">界面暂时无法显示</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">可以尝试恢复界面。本机模型配置和已保存的会话不会被清除。</p>
          <div className="mt-6 flex gap-3">
            <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white" onClick={() => {
              this.props.onRecover();
              this.setState({ failed: false });
            }}>恢复界面</button>
            <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={() => window.location.reload()}>重新加载</button>
          </div>
        </section>
      </main>
    );
  }
}
