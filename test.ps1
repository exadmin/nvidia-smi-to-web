$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/build.ps1"
javac --release 21 -encoding UTF-8 -cp target/classes -d target/test-classes src/test/java/monitor/MonitorTest.java
if ($LASTEXITCODE) { throw 'Test compilation failed' }
java -cp 'target/classes;target/test-classes' monitor.MonitorTest
if ($LASTEXITCODE) { throw 'Tests failed' }
