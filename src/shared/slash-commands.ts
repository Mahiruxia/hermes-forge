import type { SlashCommand } from "./types";

/** Desktop commands must also be available before optional overview data loads. */
export const DESKTOP_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "显示可用命令", usage: "/help" },
  { name: "/clear", description: "清空当前会话", usage: "/clear" },
  { name: "/model", description: "切换或查看模型", usage: "/model <模型名>" },
  { name: "/workspace", description: "切换工作区", usage: "/workspace <名称或路径>" },
  { name: "/new", description: "新建会话", usage: "/new" },
  { name: "/skills", description: "查看已安装技能", usage: "/skills" },
  { name: "/memory", description: "查看 Hermes 记忆", usage: "/memory" },
  { name: "/usage", description: "显示/隐藏用量", usage: "/usage" },
  { name: "/theme", description: "切换主题", usage: "/theme <green-light|light|slate|oled>" },
];

export const isDesktopSlashCommand = (name: string) => DESKTOP_SLASH_COMMANDS.some(command => command.name === name.toLowerCase());
