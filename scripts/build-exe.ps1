# 一键打包 Windows 免安装单文件 exe(Node SEA + esbuild + postject)
# 用法: powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1 [-NodeExe <path>]
param(
  [string]$NodeExe = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $NodeExe) {
  $NodeExe = "C:\Users\limul\AppData\Local\Programs\DSH Desktop\resources\node\node.exe"
}
if (-not (Test-Path $NodeExe)) { throw "找不到 node.exe: $NodeExe(可用 -NodeExe 指定)" }
$node = $NodeExe

New-Item -ItemType Directory -Force -Path .build-tools, dist | Out-Null

function Download-Tgz($name, $url, $destDir) {
  $tgz = Join-Path '.build-tools' ($name + '.tgz')
  if (-not (Test-Path $tgz)) {
    Write-Host "下载 $name ..."
    $script = "fetch('$url').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);require('fs').writeFileSync('$($tgz -replace '\\','/')',Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})"
    & $node -e $script
    if ($LASTEXITCODE -ne 0) { throw "下载失败: $name" }
  }
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  tar -xzf $tgz -C $destDir.Replace('\', '/')
}

# ---------- 1. 内嵌 Web 资源 ----------
& $node scripts/gen-embedded.js

# ---------- 2. esbuild 打包 ----------
$esbuild = '.build-tools\package\esbuild.exe'
if (-not (Test-Path $esbuild)) {
  $ver = & $node -e "fetch('https://registry.npmjs.org/esbuild/latest').then(r=>r.json()).then(j=>console.log(j.version)).catch(()=>process.exit(1))"
  Download-Tgz 'esbuild' "https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-$ver.tgz" '.build-tools'
}
Write-Host 'esbuild 打包中...'
& $esbuild server.js --bundle --platform=node --format=cjs --target=node20 --external:node:sea --outfile=dist/bundle.cjs
if ($LASTEXITCODE -ne 0) { throw 'esbuild 打包失败' }

# ---------- 3. 生成 SEA 预置 blob ----------
'{"main":"dist/bundle.cjs","output":"dist/sea-prep.blob","disableExperimentalSEAWarning":true}' |
  Set-Content dist\sea-config.json -Encoding UTF8
& $node --experimental-sea-config dist/sea-config.json
if ($LASTEXITCODE -ne 0) { throw 'sea-config 生成失败' }

# ---------- 4. 复制 node.exe 为最终 exe ----------
$exe = 'dist\研发费用加计扣除辅助软件.exe'
Copy-Item $NodeExe $exe -Force

# ---------- 5. postject 注入 blob ----------
$postject = '.build-tools\package\dist\cli.js'
if (-not (Test-Path $postject)) {
  Download-Tgz 'postject' 'https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz' '.build-tools'
  # postject 需要 commander v8(默认导出 = program 实例)
  if (-not (Test-Path '.build-tools\node_modules\commander\index.js')) {
    Download-Tgz 'commander8' 'https://registry.npmjs.org/commander/-/commander-8.3.0.tgz' '.build-tools\tmpc'
    Move-Item '.build-tools\tmpc\package' '.build-tools\node_modules\commander'
    Remove-Item -Recurse -Force '.build-tools\tmpc'
  }
}
$env:NODE_PATH = (Resolve-Path '.build-tools\node_modules').Path
Write-Host '注入 SEA blob...'
& $node $postject $exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
$code = $LASTEXITCODE
Remove-Item Env:NODE_PATH
if ($code -ne 0) { throw 'postject 注入失败' }

$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "✅ 打包完成: $exe ($mb MB)"
