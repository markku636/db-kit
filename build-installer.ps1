<#
.SYNOPSIS
    db-kit Windows 打包腳本。自動檢查並安裝 Rust 與 Node.js，然後產出 .msi / .exe 安裝檔。

.DESCRIPTION
    流程：
      1. 檢查 Node.js（無則用 winget 安裝）
      2. 檢查 Rust / cargo（無則用 rustup 安裝）
      3. 安裝前端依賴
      4. 安裝 Tauri CLI（若未安裝）
      5. tauri build → 產出安裝檔

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
#>

# 注意：native 指令（cargo / tauri / npm）會把進度、Info、warning 寫到 stderr。
# 在 Windows PowerShell 5.1 下，$ErrorActionPreference='Stop' 會把 native stderr
# 當成終止錯誤（NativeCommandError）而中斷腳本——導致打包「明明成功卻報錯」。
# 因此全域用 Continue，native 指令一律改以 $LASTEXITCODE 明確判斷成敗；
# 真正需要中止的 cmdlet（如 Invoke-WebRequest）才單獨加 -ErrorAction Stop。
$ErrorActionPreference = "Continue"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Test-Cmd($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }
function Assert-LastExit($what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what 失敗（exit code $LASTEXITCODE）。請往上捲動查看實際錯誤輸出。"
    }
}

# 偵測 MSVC C++ Build Tools（Rust 的 x86_64-pc-windows-msvc 目標需要 link.exe）。
# 用 vswhere 查是否安裝了 VC.Tools.x86.x64 元件，比直接找 link.exe（不在 PATH）可靠。
function Test-MsvcLinker {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $false }
    $path = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    return [bool]$path
}

Write-Step "db-kit 打包開始"

# --- 1. Node.js ---
if (Test-Cmd node) {
    Write-Host "Node.js 已安裝：$(node --version)" -ForegroundColor Green
} else {
    Write-Step "未偵測到 Node.js，嘗試以 winget 安裝…"
    if (Test-Cmd winget) {
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        throw "找不到 winget，請手動安裝 Node.js LTS：https://nodejs.org/"
    }
    if (-not (Test-Cmd node)) { throw "Node.js 安裝後仍無法在此工作階段使用，請重開 PowerShell 再執行一次。" }
}

# --- 2. Rust / cargo ---
if (Test-Cmd cargo) {
    Write-Host "Rust 已安裝：$(cargo --version)" -ForegroundColor Green
} else {
    Write-Step "未偵測到 Rust，嘗試以 rustup 安裝…"
    if (Test-Cmd winget) {
        winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements
    } else {
        $rustup = "$env:TEMP\rustup-init.exe"
        Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustup -ErrorAction Stop
        & $rustup -y
    }
    $env:Path += ";$env:USERPROFILE\.cargo\bin"
    if (-not (Test-Cmd cargo)) { throw "Rust 安裝後仍無法在此工作階段使用，請重開 PowerShell 再執行一次。" }
}

# --- 2.5 MSVC C++ Build Tools（link.exe）---
if (Test-MsvcLinker) {
    Write-Host "MSVC C++ Build Tools 已安裝（link.exe 可用）" -ForegroundColor Green
} else {
    Write-Step "未偵測到 MSVC C++ Build Tools，嘗試以 winget 安裝…"
    Write-Host "注意：這會下載數 GB 的 Visual Studio Build Tools（含 Windows SDK），請耐心等候。" -ForegroundColor DarkYellow
    if (Test-Cmd winget) {
        winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
            --override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
            --accept-source-agreements --accept-package-agreements
    } else {
        throw "找不到 winget，請手動安裝 Visual Studio Build Tools 並勾選『Desktop development with C++』：https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    }
    if (-not (Test-MsvcLinker)) {
        throw "MSVC C++ Build Tools 安裝後仍未偵測到。請重開 PowerShell（必要時重開機）後再執行一次；若仍失敗，請用 Visual Studio Installer 手動勾選『Desktop development with C++』。"
    }
}

# Windows 上 Tauri 需要 WebView2（Win11 內建；Win10 多數已有）。提醒即可。
Write-Host "提醒：Tauri 需要 WebView2 Runtime（Windows 11 內建）。若缺少，安裝檔執行時會提示。" -ForegroundColor DarkYellow

# --- 3. 前端依賴 ---
Write-Step "安裝前端依賴（npm install）"
npm install
Assert-LastExit "npm install"

# --- 4. Tauri CLI ---
Write-Step "確認 Tauri CLI"
npm ls @tauri-apps/cli *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "安裝 @tauri-apps/cli（dev 依賴）"
    npm install -D "@tauri-apps/cli@^2"
    Assert-LastExit "安裝 @tauri-apps/cli"
}

# --- 5. 打包 ---
Write-Step "開始 tauri build（第一次會編譯 Rust，請耐心等候）"
npm run tauri build
Assert-LastExit "tauri build"

# --- 完成 ---
$bundleDir = "src-tauri\target\release\bundle"
Write-Step "打包完成"
if (Test-Path $bundleDir) {
    Write-Host "安裝檔位於：" -ForegroundColor Green
    Get-ChildItem -Recurse -Path $bundleDir -Include *.msi, *.exe |
        ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }
} else {
    Write-Host "找不到 bundle 目錄，請檢查上方建置輸出是否有錯誤。" -ForegroundColor Red
}


PAUSE