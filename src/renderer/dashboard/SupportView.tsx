import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  HeartHandshake,
  RefreshCw,
  Send,
  Shield,
  ShieldCheck,
  User,
  Gift,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import type { SponsorEntry, SponsorOverview } from "../../shared/types";
import alipayQr from "../assets/support/alipay-qr.jpg";
import wechatQr from "../assets/support/wechat-qr.jpg";
import { useAppStore } from "../store";
import { cn } from "./DashboardPrimitives";

export function SupportView(props: { onBack: () => void }) {
  const store = useAppStore();
  const [overview, setOverview] = useState<SponsorOverview>({ entries: [], totalCount: 0 });
  const [supporterId, setSupporterId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedbackWallOpen, setFeedbackWallOpen] = useState(false);

  const latestEntries = useMemo(() => overview.entries.slice(0, 6), [overview.entries]);

  async function refreshSponsors() {
    setLoading(true);
    try {
      const next = await window.workbenchClient.listSponsorEntries();
      setOverview(next);
    } catch (error) {
      store.error("记录同步失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  async function submitFeedback() {
    if ((!supporterId.trim() && !message.trim()) || submitting) return;
    setSubmitting(true);
    try {
      const result = await window.workbenchClient.submitSponsorEntry({
        supporterId: supporterId.trim() || "匿名反馈",
        message: message.trim() || "支持 Hermes Forge 继续打磨。",
      });
      setOverview(result.overview);
      setFeedbackWallOpen(true);
      setSupporterId("");
      setMessage("");
      store.success("已收到反馈", result.message);
    } catch (error) {
      store.error("提交失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleFeedbackWall() {
    const nextOpen = !feedbackWallOpen;
    setFeedbackWallOpen(nextOpen);
    if (nextOpen && overview.entries.length === 0) {
      await refreshSponsors();
    }
  }

  return (
    <section className="flex min-h-screen flex-col bg-[#f7f8fb] text-slate-900">
      <header className="flex h-[58px] items-center justify-between border-b border-slate-200/70 bg-white/95 px-6 backdrop-blur-md">
        <button
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          onClick={props.onBack}
          type="button"
        >
          <ArrowLeft size={15} />
          返回工作台
        </button>
        <div className="flex items-center gap-2 text-[12px] text-slate-500">
          <ShieldCheck size={15} />
          名单保存在本机应用数据中
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-6 px-7 py-7 lg:grid-cols-[minmax(0,1.28fr)_minmax(380px,0.78fr)]">
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-200/80 bg-white p-7 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
            <SupportPill />
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-950">支持与反馈 Hermes Forge</h1>
            <p className="mt-5 max-w-3xl text-[15px] leading-7 text-slate-500">
              您的赞助将帮助我们持续优化 Hermes Forge：开展更多机型与系统测试、维护连接稳定性、完善文档与使用体验，并持续迭代与维护。您也可以直接提交反馈与建议，帮助我们把 Hermes Forge 做得更好。
            </p>

            <div className="mt-7 grid max-w-4xl gap-4 sm:grid-cols-3">
              <Metric icon={Gift} label="反馈记录" value={`${overview.totalCount}`} tone="purple" />
              <Metric icon={ShieldCheck} label="名单状态" value={loading ? "同步中" : "已同步"} tone="green" />
              <Metric icon={Clock3} label="最近更新" value={overview.updatedAt ? formatDate(overview.updatedAt) : "等待反馈"} tone="blue" />
            </div>

            <div className="my-7 border-t border-dashed border-slate-200" />

            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <HeartHandshake size={16} className="text-slate-500" />
              选择一种方式支持我们
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <PaymentCard title="微信赞赏" description="使用微信扫一扫，赞赏支持" image={wechatQr} accent="green" />
              <PaymentCard title="支付宝支持" description="使用支付宝扫一扫，赞助支持" image={alipayQr} accent="blue" />
            </div>

            <p className="mt-5 flex items-center gap-2 text-sm text-slate-500">
              <Shield size={15} />
              赞助为自愿行为，所有支持都将用于 Hermes Forge 的开发与维护。
            </p>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold text-slate-950">反馈墙</h2>
                <p className="mt-2 text-sm text-slate-500">感谢各位点赞、浏览、试用和支持项目的佬们！</p>
                <p className="mt-1 text-sm text-slate-500">提交反馈后会同步到这里；我在服务器仪表盘的回复也会显示在这里。</p>
              </div>
              <button
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => void toggleFeedbackWall()}
                type="button"
              >
                <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
                {feedbackWallOpen ? "收起反馈墙" : "展开反馈墙"}
              </button>
            </div>
            {feedbackWallOpen ? (
              <div className="grid gap-3">
                <div className="flex justify-end">
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50"
                    onClick={() => void refreshSponsors()}
                    type="button"
                  >
                    同步记录
                  </button>
                </div>
                {latestEntries.map((entry) => <SponsorRow key={entry.id} entry={entry} />)}
                {!latestEntries.length ? (
                  <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                    暂无反馈记录。
                  </div>
                ) : null}
              </div>
            ) : (
              <button
                className="w-full rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                onClick={() => void toggleFeedbackWall()}
                type="button"
              >
                点击展开反馈墙，查看大家的反馈和小夏回复
              </button>
            )}
          </section>
        </div>

        <aside className="space-y-5">
          <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
            <h2 className="text-2xl font-semibold text-slate-950">意见反馈</h2>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              直接写下建议、问题、使用卡点，或希望 Hermes Forge 优先打磨的方向。
            </p>
            <div className="mt-5 space-y-4">
              <label className="block text-sm font-semibold text-slate-700">
                展示 ID（可选）
                <input
                  className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                  value={supporterId}
                  onChange={(event) => setSupporterId(event.target.value)}
                  maxLength={48}
                  placeholder="例如 小夏 / GitHub ID；不填则匿名"
                />
              </label>

              <label className="block text-sm font-semibold text-slate-700">
                反馈内容
                <textarea
                  className="mt-2 min-h-36 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={1000}
                  placeholder="请详细描述你的问题、建议、使用卡点，或者你希望 Hermes Forge 优先打磨的方向。"
                />
                <span className="mt-1 block text-right text-xs text-slate-400">{message.length} / 1000</span>
              </label>

              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:from-indigo-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={(!supporterId.trim() && !message.trim()) || submitting}
                onClick={() => void submitFeedback()}
                type="button"
              >
                {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                提交反馈
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-slate-950">说明事项</h2>
              <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">感谢支持</span>
            </div>
            <div className="mt-5 space-y-3">
              <Note icon={User} title="项目现状">
                我是小夏，本科应届毕业生，正在毕业、论文和现实事务之间推进 Hermes Forge。这个项目主要靠我个人时间和 AI 编码协作慢慢打磨。
              </Note>
              <Note icon={HeartHandshake} title="感谢大家">
                感谢每一位浏览、点赞、Star、试用和愿意提出建议的朋友。哪怕只是一条反馈，也会帮助我判断哪些地方最值得优先改进。
              </Note>
              <Note icon={Gift} title="赞助用途">
                赞助会优先用于真实 Windows 机器测试、安装包签名、连接器稳定性、文档整理和后续发布成本；反馈同样重要，可以直接告诉我哪里难用、哪里卡住、希望先做什么。
              </Note>
              <Note icon={LockKeyhole} title="隐私边界">
                当前版本不会读取支付账号、交易流水或任何敏感支付凭据；提交内容只用于展示 ID 和留言 / 反馈。正式支付核验需要后续接入商户回调。
              </Note>
              <Note icon={TriangleAlert} title="请勿填写隐私">
                请勿在留言中填写手机号、身份证、Token、Cookie、API Key 或其他隐私内容。
              </Note>
            </div>
          </section>
        </aside>
      </main>
    </section>
  );
}

function SupportPill() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-4 py-1.5 text-sm font-semibold text-rose-700">
      <HeartHandshake size={16} />
      赞助与反馈
    </div>
  );
}

function Metric(props: { icon: typeof Gift; label: string; value: string; tone: "purple" | "green" | "blue" }) {
  const Icon = props.icon;
  const toneClass = {
    purple: "bg-violet-50 text-violet-600",
    green: "bg-emerald-50 text-emerald-600",
    blue: "bg-blue-50 text-blue-600",
  }[props.tone];
  return (
    <div className="flex items-center gap-4 rounded-lg bg-slate-50 px-5 py-4">
      <div className={cn("grid h-12 w-12 place-items-center rounded-lg", toneClass)}>
        <Icon size={22} />
      </div>
      <div>
        <p className="text-xs text-slate-400">{props.label}</p>
        <p className="mt-1 text-lg font-semibold text-slate-900">{props.value}</p>
      </div>
    </div>
  );
}

function PaymentCard(props: { title: string; description: string; image: string; accent: "green" | "blue" }) {
  return (
    <div className={cn(
      "rounded-xl border p-5 text-center",
      props.accent === "green" ? "border-emerald-100 bg-emerald-50/40" : "border-blue-100 bg-blue-50/40",
    )}>
      <div className="mb-2 flex items-center justify-center gap-2 text-lg font-semibold text-slate-900">
        <span className={cn("h-5 w-5 rounded-md", props.accent === "green" ? "bg-emerald-500" : "bg-blue-500")} />
        {props.title}
      </div>
      <p className="mb-4 text-sm text-slate-500">{props.description}</p>
      <img
        alt={props.title}
        className="mx-auto aspect-square w-full max-w-[260px] rounded-lg bg-white object-contain shadow-sm"
        src={props.image}
      />
    </div>
  );
}

function Note(props: { icon: typeof User; title: string; children: React.ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="flex gap-3 rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-violet-600 shadow-sm">
        <Icon size={18} />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{props.title}</h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">{props.children}</p>
      </div>
    </div>
  );
}

function SponsorRow(props: { entry: SponsorEntry }) {
  return (
    <div className="rounded-lg bg-slate-50 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{props.entry.supporterId}</p>
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              props.entry.status === "verified" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
            )}>
              <CheckCircle2 size={12} />
              {feedbackStatusLabel(props.entry.status)}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{props.entry.message}</p>
          {props.entry.reply ? (
            <div className="mt-3 rounded-lg border-l-4 border-emerald-500 bg-emerald-50 px-3 py-2">
              <p className="text-xs font-semibold text-emerald-700">小夏回复</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{props.entry.reply}</p>
            </div>
          ) : null}
        </div>
        <time className="shrink-0 text-sm text-slate-400">{formatDate(props.entry.createdAt)}</time>
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function feedbackStatusLabel(status: SponsorEntry["status"]) {
  const labels: Record<SponsorEntry["status"], string> = {
    self_reported: "已提交",
    verified: "已确认",
    new: "新反馈",
    read: "已读",
    planned: "已规划",
    done: "已完成",
    hidden: "已隐藏",
  };
  return labels[status] ?? "已提交";
}
