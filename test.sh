#!/bin/sh
set -eu
cd "$(dirname "$0")"
sh build.sh
mkdir -p target/test-classes
javac --release 21 -encoding UTF-8 -cp target/classes -d target/test-classes src/test/java/monitor/MonitorTest.java
java -cp target/classes:target/test-classes monitor.MonitorTest
