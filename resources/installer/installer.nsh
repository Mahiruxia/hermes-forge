!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 Hermes Forge"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "Hermes Forge 将为你安装本地优先的 AI 工作台。$\r$\n$\r$\n应用安装后即可打开。首次使用时，向导会联网准备 Hermes 和独立 Python 环境，并引导你配置模型。$\r$\n$\r$\nWindows 无需预装 Python、Node.js 或 WSL；已有 Hermes 也可以直接连接。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎卸载 Hermes Forge"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "这个向导会从当前设备移除 Hermes Forge。$\r$\n$\r$\n你也可以重新安装新版本，继续使用现有工作流。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
