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
    # 預設：每次打包前自動把 patch 版本號 +1（0.1.0 → 0.1.1），三個檔同步。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -Bump minor
    # 進 minor（0.1.5 → 0.2.0）；major 同理（0.2.0 → 1.0.0）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -Bump none
    # 不動版本號，照目前版本打包。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -SetVersion 1.2.3
    # 直接指定版本號。
#>

param(
    # 版本號遞增方式：patch（預設）/ minor / major / none（不遞增）。
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$Bump = "patch",

    # 直接指定版本號（major.minor.patch），優先於 -Bump。
    [string]$SetVersion
)

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

# --- 版本號工具 ---------------------------------------------------------------
# 版本號散落三個檔，以 tauri.conf.json（實際決定安裝檔版本者）為單一事實來源，
# 打包前同步更新另外兩個，三者永遠一致。
# 用 $PSScriptRoot 取絕對路徑：.NET File API 用的是 process 工作目錄、未必等於腳本所在處。
$VersionFiles = @{
    TauriConf = Join-Path $PSScriptRoot "src-tauri\tauri.conf.json"
    PkgJson   = Join-Path $PSScriptRoot "package.json"
    CargoToml = Join-Path $PSScriptRoot "src-tauri\Cargo.toml"
}

# 一律用 UTF-8 讀寫（檔內含中文註解）。PS 5.1 的 Get-Content/Set-Content 預設走系統 ANSI，
# 會把中文讀壞；.NET ReadAllText 預設 UTF-8（自動辨識 BOM），WriteAllText 指定不帶 BOM。
function Read-TextFile([string]$path) { [System.IO.File]::ReadAllText($path) }
function Write-Utf8NoBom([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))
}

function Get-CurrentVersion {
    $m = [regex]::Match((Read-TextFile $VersionFiles.TauriConf), '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { throw "在 tauri.conf.json 找不到 version 欄位。" }
    return $m.Groups[1].Value
}

function Step-Version([string]$v, [string]$kind) {
    if ($v -notmatch '^\d+\.\d+\.\d+$') { throw "目前版本 '$v' 非 major.minor.patch 格式，無法自動遞增。" }
    $p = $v -split '\.'
    [int]$maj = $p[0]; [int]$min = $p[1]; [int]$pat = $p[2]
    switch ($kind) {
        "major" { $maj++; $min = 0; $pat = 0 }
        "minor" { $min++; $pat = 0 }
        "patch" { $pat++ }
    }
    return "$maj.$min.$pat"
}

function Set-AllVersions([string]$newVersion) {
    # JSON：唯一的 "version": "..." 就是頂層版本（依賴項不含此鍵），取第一個即可。
    foreach ($f in @($VersionFiles.TauriConf, $VersionFiles.PkgJson)) {
        $re = [regex]'("version"\s*:\s*")[^"]+(")'
        Write-Utf8NoBom $f ($re.Replace((Read-TextFile $f), ('${1}' + $newVersion + '${2}'), 1))
    }
    # Cargo.toml：只改 [package] 區的 version（行首），依賴用的是行內 `{ version = "2" }` 不會被動到。
    $reCargo = [regex]::new('(?m)^(version\s*=\s*")[^"]+(")')
    Write-Utf8NoBom $VersionFiles.CargoToml ($reCargo.Replace((Read-TextFile $VersionFiles.CargoToml), ('${1}' + $newVersion + '${2}'), 1))
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

# --- 4.5 版本號遞增（打包前，讓本次安裝檔帶新版本號）---
if ($SetVersion) {
    if ($SetVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "-SetVersion 需為 major.minor.patch（例：1.2.3），收到 '$SetVersion'。"
    }
    Write-Step "設定版本號"
    $old = Get-CurrentVersion
    Set-AllVersions $SetVersion
    Write-Host "版本號：$old -> $SetVersion（tauri.conf.json / package.json / Cargo.toml 已同步）" -ForegroundColor Green
} elseif ($Bump -ne "none") {
    Write-Step "遞增版本號（-Bump $Bump）"
    $old = Get-CurrentVersion
    $new = Step-Version $old $Bump
    Set-AllVersions $new
    Write-Host "版本號：$old -> $new（tauri.conf.json / package.json / Cargo.toml 已同步）" -ForegroundColor Green
} else {
    Write-Host "略過版本號遞增（-Bump none），照目前版本打包：$(Get-CurrentVersion)" -ForegroundColor DarkYellow
}

# --- 4.9 規避「target 目錄路徑問題」------------------------------------------
# 在 Windows 上，Tauri 建置（tauri-codegen）會讀 target 目錄底下自動產生的權限檔
# （target\release\build\tauri-*\out\permissions\*.toml）。本專案的 in-tree target
# 曾殘留「舊位置／舊名稱」的絕對路徑：專案原本在 D:\at-kit，後來搬到目前含空白的
# 路徑（D:\01 qen3_tts\...\db-kit）並改名 db-kit，但舊 target 內仍指向 D:\at-kit\...，
# 導致讀檔失敗（os error 3，找不到路徑）而建置中止。此外 Tauri 在 Windows 對「含
# 空白的路徑」本來就容易出狀況。
# 解法：把 Rust 的 target 目錄改到一個「全新且不含空白」的位置，同時避開上述兩個
# 問題；原始碼仍留在原處（前端 vite 對含空白的原路徑沒問題，不可改用 junction，
# 否則 vite/realpath 會把路徑解回含空白的真實路徑而換成另一種錯）。
$targetDir = Join-Path $PSScriptRoot "src-tauri\target"   # 預設：專案內 target（路徑無空白時用這個）
if ($PSScriptRoot -match '\s') {
    $relocated = Join-Path $env:LOCALAPPDATA "db-kit\rust-target"
    if ($relocated -match '\s') {
        Write-Host "警告：替代 target 目錄仍含空白（$relocated），Tauri 可能仍會失敗。請改用不含空白的路徑。" -ForegroundColor Red
    }
    $env:CARGO_TARGET_DIR = $relocated
    $targetDir = $relocated
    Write-Host "偵測到專案路徑含空白，已將 Rust target 目錄改到不含空白處：$relocated" -ForegroundColor Yellow
}

# --- 4.95 CMake generator（Kafka 的 librdkafka 需 CMake 編 C 原始碼）------------
# 本專案打包一律含 Kafka（default features）。Kafka 的 rdkafka-sys 會用 CMake 編 librdkafka，
# 而 CMake 預設自動挑「最新」的 Visual Studio 當 generator。若機器同時裝了較新的 VS
# （如 VS 2026 / v18）但 CMake 版本不認得該 generator 名稱（"Visual Studio 18 2026"），
# 建置會失敗（CMake Error: Could not create named generator …）。
# 解法：只要偵測到 VS 2022（v17，CMake 3.21+ 皆支援），就明確指定它當 generator，
# 讓 Kafka 一律編得過，不受更新版 VS 影響。
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vs2022 = & $vswhere -version "[17.0,18.0)" -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    if ($vs2022) {
        $env:CMAKE_GENERATOR = "Visual Studio 17 2022"
        Write-Host "已指定 CMake generator = Visual Studio 17 2022（避開較新 VS 的 generator 未被 CMake 認得的問題，確保 Kafka/librdkafka 編得過）" -ForegroundColor Yellow
    } else {
        Write-Host "警告：未偵測到 VS 2022（v17）的 C++ 工具。若 CMake 版本太舊、機器只有更新版 VS，Kafka（librdkafka）可能編不過——請更新 CMake 或安裝 VS 2022 Build Tools。" -ForegroundColor DarkYellow
    }
}

# --- 5. 打包（含 Kafka：default features = gui + kafka + kafka-js + elastic + rabbitmq）---
Write-Step "開始 tauri build（第一次會編譯 Rust，請耐心等候）"
npm run tauri build
Assert-LastExit "tauri build"

# --- 完成：把安裝檔收整到帶版號的 release 目錄 ---
# Tauri 預設把產物丟在 target\release\bundle（且 target 可能已被改到不含空白處，見 4.9），
# 路徑深、又散在 msi\ 與 nsis\ 兩個子夾。這裡統一複製到「專案內 release\v<版本>\」，
# 檔名本身已含版號（DB Kit_<版本>_x64-setup.exe / DB Kit_<版本>_x64_en-US.msi），
# 一眼可辨、方便發佈與封存。
$bundleDir = Join-Path $targetDir "release\bundle"   # target 目錄可能已被改到不含空白處（見 4.9）
Write-Step "打包完成"
if (Test-Path $bundleDir) {
    $version    = Get-CurrentVersion
    $releaseDir = Join-Path $PSScriptRoot "release\v$version"
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

    $artifacts = Get-ChildItem -Recurse -Path $bundleDir -Include *.msi, *.exe
    if ($artifacts) {
        foreach ($a in $artifacts) {
            Copy-Item -Path $a.FullName -Destination $releaseDir -Force
        }
        Write-Host "安裝檔（v$version）已輸出到：$releaseDir" -ForegroundColor Green
        Get-ChildItem -Path $releaseDir -Include *.msi, *.exe -Recurse |
            ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1MB,1)) MB)" -ForegroundColor Green }
    } else {
        Write-Host "bundle 目錄存在但找不到 .msi / .exe，請檢查上方建置輸出。" -ForegroundColor Red
    }
} else {
    Write-Host "找不到 bundle 目錄，請檢查上方建置輸出是否有錯誤。" -ForegroundColor Red
}


PAUSE