# db-kit Kafka build helper (Windows).
#
# rdkafka (librdkafka) needs CMake + MSVC. This script puts the VS 2022 BuildTools
# CMake on PATH and pins the VS 17 generator, then runs cargo with your args.
#
# Why the generator is pinned: if VS 2026 (v18) is installed, the `cmake` crate
# auto-selects the "Visual Studio 18 2026" generator, which the bundled CMake 3.31
# cannot create -> build fails. Forcing "Visual Studio 17 2022" uses the v17 toolset.
#
# Kafka Cargo features:
#   kafka      (default, on with gui): PLAINTEXT + SASL_PLAINTEXT/PLAIN. No OpenSSL.
#   kafka-tls  (opt-in):               adds rdkafka/ssl for TLS / SASL_SSL / SCRAM.
#                                      Needs a prebuilt OpenSSL. Set OPENSSL_DIR to a
#                                      prebuilt OpenSSL (vcpkg / distribution) so the
#                                      build does NOT compile OpenSSL (avoids NASM/Perl),
#                                      and bundle the OpenSSL DLLs with the installer.
#
# Usage examples:
#   .\build-kafka.ps1                             # cargo build (gui + kafka)
#   .\build-kafka.ps1 check --features kafka
#   .\build-kafka.ps1 clippy --features kafka
#   .\build-kafka.ps1 build --release --features kafka-tls   # needs OPENSSL_DIR
#   .\build-kafka.ps1 tauri build

param([Parameter(ValueFromRemainingArguments = $true)] $Rest)

$ErrorActionPreference = "Stop"

$cmakeBin = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
if (Test-Path (Join-Path $cmakeBin "cmake.exe")) {
    $env:PATH = "$cmakeBin;$env:PATH"
} elseif (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Write-Error "CMake not found. Install CMake, or the Visual Studio C++ (Desktop) workload which bundles it."
    exit 1
}

if (-not $env:CMAKE_GENERATOR) { $env:CMAKE_GENERATOR = "Visual Studio 17 2022" }
# Limit parallel codegen to avoid the known rustc/LLVM OOM on this project.
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = "2" }

Push-Location (Join-Path $PSScriptRoot "src-tauri")
try {
    if ($Rest) {
        Write-Host "cargo $Rest  (CMAKE_GENERATOR=$env:CMAKE_GENERATOR, CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS)"
        & cargo @Rest
    } else {
        Write-Host "cargo build  (default features: gui + kafka)"
        & cargo build
    }
} finally {
    Pop-Location
}
