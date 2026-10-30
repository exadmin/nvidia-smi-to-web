#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p target/classes
javac --release 21 --add-modules jdk.httpserver -encoding UTF-8 -d target/classes src/main/java/monitor/Main.java
cp -R src/main/resources/. target/classes/
jar --create --file target/tesla-monitor-1.0.0.jar --main-class monitor.Main -C target/classes .
