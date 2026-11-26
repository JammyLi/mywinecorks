; MyWineCorks — Windows installer (NSIS 3, Unicode). Built by build.sh:
;   makensis -DVERSION=… -DSTAGE=… -DOUTFILE=… mywinecorks.nsi
; Installs the server as a Windows service (WinSW), opens the firewall for the office network only,
; and on a new install opens the one-time setup link (no default password).
Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APPNAME "MyWineCorks"
!define SVC "MyWineCorks"
!define PORT "3500"
!define HTTPS_PORT "5543"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MyWineCorks"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\MyWineCorks"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"
!ifndef NUMVERSION
  !define NUMVERSION "${VERSION}"
!endif
VIProductVersion "${NUMVERSION}.0" ; numbers only (1.0.0-beta.1 → 1.0.0.0)
VIAddVersionKey "ProductName" "MyWineCorks"
VIAddVersionKey "CompanyName" "MyWineCorks"
VIAddVersionKey "FileDescription" "MyWineCorks Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MyWineCorks"

!define MUI_ICON "${STAGE}\mywinecorks.ico"
!define MUI_UNICON "${STAGE}\mywinecorks.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(OpenText)"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp
!define MUI_FINISHPAGE_TEXT "$(FinishText)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_RESERVEFILE_LANGDLL

LangString WelcomeText ${LANG_TRADCHINESE} "這個程式會把 MyWineCorks 酒窖管理系統安裝在這台電腦上，並設定成開機自動執行。$\r$\n$\r$\n公司裡的其他電腦和手機，只要連上同一個網路，就能用瀏覽器開啟，不需要另外安裝。$\r$\n$\r$\n資料存在這台電腦（C:\ProgramData\MyWineCorks），每次更新前都會自動備份。"
LangString WelcomeText ${LANG_ENGLISH} "This installs the MyWineCorks cellar server on this computer and starts it automatically with Windows.$\r$\n$\r$\nOther computers and phones on the same network open it in a browser — nothing to install there.$\r$\n$\r$\nData stays on this computer (C:\ProgramData\MyWineCorks) and is backed up automatically before every update."
LangString OpenText ${LANG_TRADCHINESE} "開啟 MyWineCorks"
LangString OpenText ${LANG_ENGLISH} "Open MyWineCorks"
LangString FinishText ${LANG_TRADCHINESE} "安裝完成。$\r$\n$\r$\n新安裝：瀏覽器會開啟設定頁，請輸入公司名稱與擁有者，再設定密碼（沒有預設密碼）。$\r$\n$\r$\n開始功能表「MyWineCorks › 連線位址」會顯示其他電腦和手機要輸入的網址。"
LangString FinishText ${LANG_ENGLISH} "Done.$\r$\n$\r$\nNew install: the browser opens the setup page — enter your company and the Owner, then set the password (there is no default password).$\r$\n$\r$\nStart menu › MyWineCorks › Addresses shows the address for other computers and phones."
LangString Need64 ${LANG_TRADCHINESE} "MyWineCorks 需要 64 位元的 Windows 10 或 11。"
LangString Need64 ${LANG_ENGLISH} "MyWineCorks needs 64-bit Windows 10 or 11."
LangString UninstDone ${LANG_TRADCHINESE} "已解除安裝程式。資料沒有刪除，仍保存在 $APPDATA\MyWineCorks；重新安裝後會自動接續使用。"
LangString UninstDone ${LANG_ENGLISH} "MyWineCorks was removed. Your data was not deleted — it is still in $APPDATA\MyWineCorks and is used again if you reinstall."
LangString LinkApp ${LANG_TRADCHINESE} "MyWineCorks 酒窖"
LangString LinkApp ${LANG_ENGLISH} "MyWineCorks"
LangString LinkPhone ${LANG_TRADCHINESE} "手機設定"
LangString LinkPhone ${LANG_ENGLISH} "Phone setup"
LangString LinkAddr ${LANG_TRADCHINESE} "連線位址"
LangString LinkAddr ${LANG_ENGLISH} "Addresses"
LangString LinkData ${LANG_TRADCHINESE} "資料與備份資料夾"
LangString LinkData ${LANG_ENGLISH} "Data and backups folder"
LangString LinkUninst ${LANG_TRADCHINESE} "解除安裝"
LangString LinkUninst ${LANG_ENGLISH} "Uninstall"
LangString Starting ${LANG_TRADCHINESE} "啟動 MyWineCorks 服務…"
LangString Starting ${LANG_ENGLISH} "Starting the MyWineCorks service…"

Var DATA
Var FIRSTRUN

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "$(Need64)"
    Abort
  ${EndIf}
  SetRegView 64
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Function OpenApp
  ${If} $FIRSTRUN != ""
    ExecShell "open" "$FIRSTRUN"
  ${Else}
    ExecShell "open" "http://localhost:${PORT}"
  ${EndIf}
FunctionEnd

!macro StopService
  IfFileExists "$INSTDIR\MyWineCorksService.exe" 0 +4
    nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" uninstall'
    Sleep 2000
!macroend

Section "Install"
  SetShellVarContext all
  StrCpy $DATA "$APPDATA\MyWineCorks"   ; = C:\ProgramData\MyWineCorks
  StrCpy $FIRSTRUN ""

  !insertmacro StopService
  RMDir /r "$INSTDIR\app"

  SetOutPath "$INSTDIR"
  File "${STAGE}\node.exe"
  File "${STAGE}\MyWineCorksService.exe"
  File "${STAGE}\launcher.mjs"
  File "${STAGE}\mywinecorks.ico"
  File "${STAGE}\connect-info.cmd"
  File /r "${STAGE}\app"

  CreateDirectory "$DATA"
  CreateDirectory "$DATA\logs"
  ; Data folder: only Administrators and the service account (it holds the databases and keys).
  nsExec::ExecToLog 'icacls "$DATA" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"'

  FileOpen $0 "$INSTDIR\MyWineCorksService.xml" w
  FileWrite $0 '<service>$\r$\n'
  FileWrite $0 '  <id>${SVC}</id>$\r$\n'
  FileWrite $0 '  <name>MyWineCorks</name>$\r$\n'
  FileWrite $0 '  <description>MyWineCorks cellar server (http ${PORT}, https ${HTTPS_PORT})</description>$\r$\n'
  FileWrite $0 '  <executable>$INSTDIR\node.exe</executable>$\r$\n'
  FileWrite $0 '  <arguments>"$INSTDIR\launcher.mjs"</arguments>$\r$\n'
  FileWrite $0 '  <workingdirectory>$INSTDIR</workingdirectory>$\r$\n'
  FileWrite $0 '  <env name="DATA_DIR" value="$DATA"/>$\r$\n'
  FileWrite $0 '  <env name="PORT" value="${PORT}"/>$\r$\n'
  FileWrite $0 '  <env name="HTTPS_PORT" value="${HTTPS_PORT}"/>$\r$\n'
  FileWrite $0 '  <env name="MWC_PLATFORM" value="win-x64"/>$\r$\n'
  FileWrite $0 '  <env name="NODE_ENV" value="production"/>$\r$\n'
  FileWrite $0 '  <startmode>Automatic</startmode>$\r$\n'
  FileWrite $0 '  <onfailure action="restart" delay="10 sec"/>$\r$\n'
  FileWrite $0 '  <stoptimeout>20 sec</stoptimeout>$\r$\n'
  FileWrite $0 '  <logpath>$DATA\logs</logpath>$\r$\n'
  FileWrite $0 '  <log mode="roll-by-size"><sizeThreshold>2048</sizeThreshold><keepFiles>5</keepFiles></log>$\r$\n'
  FileWrite $0 '</service>$\r$\n'
  FileClose $0

  DetailPrint "$(Starting)"
  nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" install'
  nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" start'

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MyWineCorks"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="MyWineCorks" dir=in action=allow protocol=TCP localport=${PORT},${HTTPS_PORT} remoteip=localsubnet profile=any'

  ; New install: wait (up to ~40 s) for the server to write its one-time setup link.
  StrCpy $1 0
  ${Do}
    ${If} ${FileExists} "$DATA\first-run.txt"
      FileOpen $2 "$DATA\first-run.txt" r
      FileRead $2 $FIRSTRUN
      FileClose $2
      ${Break}
    ${EndIf}
    ; An existing installation (upgrade) has no setup link: stop waiting once it is up.
    ${If} ${FileExists} "$DATA\version.json"
    ${AndIf} $1 > 8
      ${Break}
    ${EndIf}
    Sleep 1000
    IntOp $1 $1 + 1
  ${LoopUntil} $1 > 40
  ; drop the line break
  StrCpy $3 $FIRSTRUN 1 -1
  ${If} $3 == "$\n"
    StrCpy $FIRSTRUN $FIRSTRUN -1
  ${EndIf}
  StrCpy $3 $FIRSTRUN 1 -1
  ${If} $3 == "$\r"
    StrCpy $FIRSTRUN $FIRSTRUN -1
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\MyWineCorks"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkApp).url" "InternetShortcut" "URL" "http://localhost:${PORT}"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkApp).url" "InternetShortcut" "IconFile" "$INSTDIR\mywinecorks.ico"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkApp).url" "InternetShortcut" "IconIndex" "0"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkPhone).url" "InternetShortcut" "URL" "http://localhost:${PORT}/phone"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkPhone).url" "InternetShortcut" "IconFile" "$INSTDIR\mywinecorks.ico"
  WriteINIStr "$SMPROGRAMS\MyWineCorks\$(LinkPhone).url" "InternetShortcut" "IconIndex" "0"
  CreateShortCut "$SMPROGRAMS\MyWineCorks\$(LinkAddr).lnk" "$INSTDIR\connect-info.cmd" "" "$INSTDIR\mywinecorks.ico"
  CreateShortCut "$SMPROGRAMS\MyWineCorks\$(LinkData).lnk" "$DATA"
  CreateShortCut "$SMPROGRAMS\MyWineCorks\$(LinkUninst).lnk" "$INSTDIR\Uninstall.exe"
  WriteINIStr "$DESKTOP\$(LinkApp).url" "InternetShortcut" "URL" "http://localhost:${PORT}"
  WriteINIStr "$DESKTOP\$(LinkApp).url" "InternetShortcut" "IconFile" "$INSTDIR\mywinecorks.ico"
  WriteINIStr "$DESKTOP\$(LinkApp).url" "InternetShortcut" "IconIndex" "0"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "MyWineCorks"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\mywinecorks.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetRegView 64
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\MyWineCorksService.exe" uninstall'
  Sleep 2000
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="MyWineCorks"'
  RMDir /r "$SMPROGRAMS\MyWineCorks"
  Delete "$DESKTOP\$(LinkApp).url"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\launcher.mjs"
  Delete "$INSTDIR\MyWineCorksService.exe"
  Delete "$INSTDIR\MyWineCorksService.xml"
  Delete "$INSTDIR\mywinecorks.ico"
  Delete "$INSTDIR\connect-info.cmd"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  IfSilent +2
    MessageBox MB_ICONINFORMATION "$(UninstDone)"
SectionEnd
