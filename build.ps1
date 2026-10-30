$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force target/classes | Out-Null
New-Item -ItemType Directory -Force target/tmp | Out-Null
javac --release 21 --add-modules jdk.httpserver -encoding UTF-8 -d target/classes src/main/java/monitor/Main.java
if ($LASTEXITCODE) { throw 'Compilation failed' }
Copy-Item src/main/resources/* target/classes -Recurse -Force
jar "-J-Djava.io.tmpdir=$PSScriptRoot/target/tmp" --create --file target/tesla-monitor-1.0.0.jar --main-class monitor.Main -C target/classes .
if ($LASTEXITCODE) { throw 'Packaging failed' }
