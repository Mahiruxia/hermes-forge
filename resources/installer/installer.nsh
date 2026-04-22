!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 Hermes Forge"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "Hermes Forge 将为你安装一套本地优先的 Hermes 工作台。$\r$\n$\r$\n下一步你可以自定义安装位置，安装完成后即可直接启动应用。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎卸载 Hermes Forge"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "这个向导会从当前设备移除 Hermes Forge。$\r$\n$\r$\n你也可以重新安装新版本，继续使用现有工作流。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
