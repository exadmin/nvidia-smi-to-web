# nvidia-smi-to-web

A lightweight NVIDIA GPU dashboard using Java 21+ and the embedded JDK HTTP server, with no third-party runtime dependencies. Targets Windows 11 and Ubuntu 26.x on x86-64.

[GitHub repository](https://github.com/exadmin/nvidia-smi-to-web)

Requires an NVIDIA driver compatible with your GPU and OS, and `nvidia-smi`. Python, NVML bindings and CUDA Toolkit are not required.

## Build and run

With Maven:

```sh
mvn package
java -jar target/nvidia-smi-to-web-1.0.0.jar
```

Without Maven, using standard JDK tools on Windows PowerShell:

```powershell
./build.ps1
java -jar target/nvidia-smi-to-web-1.0.0.jar
```

On Ubuntu:

```sh
sh build.sh
java -jar target/nvidia-smi-to-web-1.0.0.jar
```

Open [localhost:8080](http://127.0.0.1:8080). The same JAR runs on both platforms with Java 21+ installed.

Options:

```sh
java -jar target/nvidia-smi-to-web-1.0.0.jar --host 0.0.0.0 --port 8080 --nvidia-smi /usr/bin/nvidia-smi
java -jar target/nvidia-smi-to-web-1.0.0.jar --demo
```

Quote executable paths containing spaces. By default, the executable is resolved through the Java process's PATH, which may differ for system services. Demo mode is explicitly labeled in the UI, API and console.

The server binds to loopback by default. Network mode has no built-in authentication; use a reverse proxy with TLS and authentication for internet access.

## Dashboard

Current readings for all GPUs appear first, followed by a separate history section. Charts show temperature, SM and memory clocks, GPU utilization, VRAM usage and power. Available periods: 1, 5, 10 and 15 minutes, 1 hour and 4 hours. The default is 5 minutes.

## Sampling and memory

One collector polls all GPUs with a 2-second delay after each completed poll and a 5-second process timeout. Actual spacing is 2 seconds plus command execution time. Multiple browsers share the collector. On failure, last successful readings are marked stale and no duplicate history points are added. Unsupported values become `null` in the API.

Each GPU has a 7200-point ring buffer of primitive arrays: a `long` timestamp and 11 `double` metrics per point. Two GPUs require 1,382,400 bytes (about 1.32 MiB), plus small object overhead. Total JVM memory is higher due to runtime, HTTP and JSON allocations.

Points older than 4 hours are excluded. History is lost on restart. GPUs absent for over 4 hours are removed; a 64-UUID limit bounds memory growth.

Metrics: temperature, SM/memory clocks, used/total VRAM, GPU utilization, power draw/limit, fan speed and current PCIe generation/width. UUID identifies each GPU. Passive Tesla cards may not report fan speed. Memory temperature and throttle reasons are not included.

## API

- `GET /api/gpus`: current readings and history. `metrics` defines the order of `values`; each history row is `[timestampMillis, ...values]`.
- `GET /api/gpus?since=timestampMillis`: points strictly newer than the timestamp. The UI loads full history initially, then increments.
- `GET /api/health`: HTTP 200 for fresh successful readings, otherwise 503; includes `demo`.

## Tests

```powershell
./test.ps1
```

```sh
sh test.sh
```

Checks cover CSV parsing, unavailable sensors, ring-buffer rollover, expiration, incremental JSON, and process output/error/timeout handling. Use `--demo` to inspect the UI without NVIDIA hardware. Verify actual sensors by running without that flag.
