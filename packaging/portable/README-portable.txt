db-kit 免安裝版（Windows x64）
================================

解壓到任何位置後直接執行 db-kit.exe 即可，不需要安裝、不寫登錄檔。
整個資料夾可以放在 USB 隨身碟或網路磁碟，換一台電腦接著用。


包含哪些檔案
------------

  db-kit.exe                 主程式
  dbk.exe                    命令列工具（查詢、匯出、MCP 伺服器）
  dbk-rustdesk-bridge.exe     遠端桌面（RustDesk 相容連線）用的輔助程式
  *.dll                      VC++ runtime（執行檔需要，不必另外安裝）
  portable.txt               可攜模式標記（刪掉就改用 %APPDATA%，詳見該檔）
  data\                      第一次啟動後自動建立，所有設定都在這裡
  oracle\                    Oracle 連線元件（見下方「Oracle 連線」）
  LICENSE                    db-kit 本身的授權（MIT）
  ORACLE-NOTICE.txt          oracle\ 內容的授權條款與使用條件


設定存在哪裡
------------

都在 data\ 底下，跟著資料夾走：連線清單與群組、AI 程式庫、助手工作區、
SSH 與遠端桌面的主機指紋，以及介面偏好（語言、AI 人設、側欄寬度、分頁狀態等，
存在 data\EBWebView）。快取與記錄檔分別在 data\caches 與 data\logs。
一般模式下這些東西會落在 %APPDATA% 與 %LOCALAPPDATA%，可攜模式一律改寫 data\，
用過的電腦上不留設定。

例外：連線密碼、SSH 密碼與金鑰密語存在「Windows 憑證管理員」，屬於這台電腦的
使用者帳戶，不會寫進 data\、也不會跟著隨身碟走。換電腦後連線設定都在，
但密碼要重新輸入一次（這是刻意的，避免把密碼明文帶在隨身碟上）。

要同時保留多份互不干擾的設定，可以用環境變數指定目錄：

  set DB_KIT_DATA_DIR=D:\dbkit-work
  db-kit.exe


Oracle 連線
-----------

oracle\ 已經放好連線 Oracle 需要的元件，不必另外安裝或設定 PATH。
程式找 client 的順序是：連線設定裡的「Instant Client 目錄」→ 這個 oracle\
資料夾 → 環境變數 ORACLE_HOME → PATH。

兩種情況要自己處理：

1. 這份元件可連 Oracle Database 19c 以上。更舊的資料庫（12c、18c）請自備
   19.x 版元件：把 oracle\ 內容換成 19.x 的檔案，或在連線設定的
   「Instant Client 目錄」填上它的路徑。

2. 第一次連線若出現 DPI-1047（找不到 client 或架構不符），請確認整包是一起解壓的、
   oracle\ 與 db-kit.exe 在同一層，且 oracle\oci.dll 存在。

要用 TNS 別名連線的話，把 tnsnames.ora 放進 oracle\network\admin\。

oracle\ 內的檔案不是 db-kit 的一部分，使用前請先看 ORACLE-NOTICE.txt。
用不到 Oracle 的話，整個 oracle\ 資料夾可以直接刪掉（約省 300 MB），
其他功能不受影響。


其他注意事項
------------

* 執行檔沒有付費簽章，第一次執行會被 SmartScreen 擋下：點「更多資訊」→
  「仍要執行」。
* 免安裝版不會自動更新，請自行下載新版覆蓋（保留 data\ 即可延用設定）。
* 把 dbk 註冊給 Claude Code / Codex 等 MCP 用戶端時，寫進去的是 dbk.exe 當下的完整路徑。
  資料夾搬家或隨身碟換了磁碟機代號，要在「AI 助手 → MCP」重新註冊一次。
* 解壓後約需 430 MB 磁碟空間，其中 Oracle 元件佔 320 MB。
