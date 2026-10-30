package monitor;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

public final class Main {
    static final String[] METRICS = {"temperature", "smClock", "memoryClock", "memoryUsed", "memoryTotal", "utilization", "power", "powerLimit", "fan", "pcieGeneration", "pcieWidth"};
    static final String QUERY = "index,uuid,name,temperature.gpu,clocks.sm,clocks.mem,memory.used,memory.total,utilization.gpu,power.draw,power.limit,fan.speed,pcie.link.gen.current,pcie.link.width.current";
    static final int CAPACITY = 7200;
    record Reading(int index, String uuid, String name, double[] values) {}
    static final class History {
        final long[] times = new long[CAPACITY];
        final double[][] values = new double[METRICS.length][CAPACITY];
        int next, size;
        Reading latest;
        long lastSeen;
        void add(long time, Reading r) {
            latest = r; lastSeen = time; times[next] = time;
            for (int m = 0; m < METRICS.length; m++) values[m][next] = r.values[m];
            next = (next + 1) % CAPACITY; size = Math.min(size + 1, CAPACITY);
        }
    }
    final Map<String, History> cards = new LinkedHashMap<>();
    final ExecutorService io = Executors.newVirtualThreadPerTaskExecutor();
    final ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor();
    final String executable;
    final boolean demo;
    String error;
    long lastAttempt, lastSuccess;
    Main(String executable, boolean demo) { this.executable = executable; this.demo = demo; }

    public static void main(String[] args) throws Exception {
        Map<String,String> options = new HashMap<>();
        for (int i=0; i<args.length; i++) {
            if (args[i].equals("--demo")) options.put("demo", "true");
            else if (Set.of("--host", "--port", "--nvidia-smi").contains(args[i]) && i+1<args.length) options.put(args[i].substring(2), args[++i]);
            else throw new IllegalArgumentException("Usage: java -jar nvidia-smi-to-web.jar [--host 127.0.0.1] [--port 8080] [--nvidia-smi path] [--demo]");
        }
        Main app = new Main(options.getOrDefault("nvidia-smi", "nvidia-smi"), options.containsKey("demo"));
        String host = options.getOrDefault("host", "127.0.0.1");
        HttpServer server = HttpServer.create(new InetSocketAddress(host, Integer.parseInt(options.getOrDefault("port", "8080"))), 32);
        server.setExecutor(app.io);
        server.createContext("/", app::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { server.stop(0); app.sampler.shutdownNow(); app.io.shutdownNow(); }));
        app.sampler.scheduleWithFixedDelay(app::sample, 0, 2, TimeUnit.SECONDS);
        server.start();
        System.out.println("nvidia-smi-to-web: http://" + host + ":" + server.getAddress().getPort() + (app.demo ? " [DEMO — synthetic data]" : ""));
    }

    void sample() {
        long start = System.currentTimeMillis();
        try {
            List<Reading> readings = demo ? demoReadings() : query();
            long now = System.currentTimeMillis();
            synchronized (this) {
                lastAttempt = start;
                // Keep memory bounded even if GPUs are repeatedly replaced.
                cards.entrySet().removeIf(e -> now - e.getValue().lastSeen > 14_400_000L);
                for (Reading r : readings) {
                    if (!cards.containsKey(r.uuid) && cards.size() >= 64) throw new IOException("GPU limit exceeded (64)");
                    cards.computeIfAbsent(r.uuid, k -> new History()).add(now, r);
                }
                error = null; lastSuccess = now;
            }
        } catch (Exception e) {
            synchronized (this) { lastAttempt = start; error = e.getMessage() == null ? e.toString() : e.getMessage(); }
            System.err.println(Instant.now() + " GPU poll failed: " + e.getMessage());
        }
    }

    List<Reading> query() throws Exception {
        return parse(runCommand(List.of(executable, "--query-gpu=" + QUERY, "--format=csv,noheader,nounits"), 5));
    }
    String runCommand(List<String> command, int timeoutSeconds) throws Exception {
        Process process = new ProcessBuilder(command).start();
        process.getOutputStream().close();
        Future<String> stdout = io.submit(() -> readLimited(process.getInputStream()));
        Future<String> stderr = io.submit(() -> readLimited(process.getErrorStream()));
        try {
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) throw new IOException("nvidia-smi timed out after " + timeoutSeconds + " seconds");
            String out = stdout.get(1, TimeUnit.SECONDS), err = stderr.get(1, TimeUnit.SECONDS);
            if (process.exitValue() != 0) throw new IOException("nvidia-smi exit " + process.exitValue() + ": " + err.strip());
            return out;
        } finally {
            if (process.isAlive()) { process.destroyForcibly(); process.waitFor(1, TimeUnit.SECONDS); }
            process.getInputStream().close(); process.getErrorStream().close();
            stdout.cancel(true); stderr.cancel(true);
        }
    }
    static String readLimited(InputStream stream) throws IOException {
        byte[] bytes = stream.readNBytes(1_048_577);
        if (bytes.length > 1_048_576) throw new IOException("nvidia-smi output exceeds 1 MiB");
        return new String(bytes, StandardCharsets.UTF_8);
    }
    static List<Reading> parse(String text) throws IOException {
        List<Reading> result = new ArrayList<>(); Set<String> uuids = new HashSet<>();
        for (String line : text.lines().filter(s -> !s.isBlank()).toList()) {
            List<String> f = csv(line);
            if (f.size() != 3 + METRICS.length) throw new IOException("Unexpected nvidia-smi CSV column count: " + f.size());
            try {
                int index = Integer.parseInt(f.get(0)); String uuid = f.get(1);
                if (!uuid.startsWith("GPU-") || !uuids.add(uuid)) throw new IllegalArgumentException("Invalid or duplicate GPU UUID");
                double[] values = new double[METRICS.length];
                for (int i=0; i<values.length; i++) {
                    try { values[i] = Double.parseDouble(f.get(i+3)); }
                    catch (NumberFormatException e) { values[i] = Double.NaN; }
                }
                result.add(new Reading(index, uuid, f.get(2), values));
            } catch (IllegalArgumentException e) { throw new IOException("Invalid nvidia-smi row: " + e.getMessage(), e); }
        }
        return result;
    }
    static List<String> csv(String line) throws IOException {
        List<String> fields = new ArrayList<>(); StringBuilder value = new StringBuilder(); boolean quoted = false;
        for (int i=0; i<line.length(); i++) {
            char c=line.charAt(i);
            if (c=='"') { if (quoted && i+1<line.length() && line.charAt(i+1)=='"') { value.append('"'); i++; } else quoted=!quoted; }
            else if (c==',' && !quoted) { fields.add(value.toString().strip()); value.setLength(0); }
            else value.append(c);
        }
        if (quoted) throw new IOException("Unclosed CSV quote");
        fields.add(value.toString().strip()); return fields;
    }
    List<Reading> demoReadings() {
        List<Reading> out = new ArrayList<>(); double t=System.currentTimeMillis()/1000.0;
        for (int i=0;i<2;i++) { double load=45+35*Math.sin(t/19+i); out.add(new Reading(i,"GPU-demo-"+i,"Tesla P100 · DEMO",new double[]{42+load*.35,600+load*7,715,2000+load*100,16384,load,40+load*1.7,250,Double.NaN,3,16})); }
        return out;
    }

    synchronized String snapshot(boolean history, long since) {
        long now=System.currentTimeMillis(), cutoff=now-14_400_000L;
        StringBuilder b=new StringBuilder("{\"demo\":").append(demo).append(",\"now\":").append(now)
            .append(",\"lastAttempt\":").append(lastAttempt).append(",\"lastSuccess\":").append(lastSuccess)
            .append(",\"error\":").append(json(error)).append(",\"metrics\":[");
        for(int i=0;i<METRICS.length;i++){if(i>0)b.append(',');b.append(json(METRICS[i]));}
        b.append("],\"cards\":["); boolean first=true;
        for(History h:cards.values()) {
            if(h.lastSeen<cutoff) continue;
            if(!first)b.append(',');first=false; Reading r=h.latest;
            b.append("{\"index\":").append(r.index).append(",\"uuid\":").append(json(r.uuid)).append(",\"name\":").append(json(r.name))
                .append(",\"lastSeen\":").append(h.lastSeen).append(",\"stale\":").append(error!=null || now-h.lastSeen>6000).append(",\"values\":");
            numbers(b,r.values); b.append(",\"history\":["); boolean pointFirst=true;
            if(history) for(int j=0;j<h.size;j++) {
                int k=(h.next-h.size+j+CAPACITY)%CAPACITY;
                if(h.times[k]<=since || h.times[k]<cutoff)continue;
                if(!pointFirst)b.append(',');pointFirst=false;
                b.append('[').append(h.times[k]); for(double[] metric:h.values){b.append(',');number(b,metric[k]);} b.append(']');
            }
            b.append("]}");
        }
        return b.append("]}").toString();
    }
    static void numbers(StringBuilder b,double[] values){b.append('[');for(int i=0;i<values.length;i++){if(i>0)b.append(',');number(b,values[i]);}b.append(']');}
    static void number(StringBuilder b,double value){if(Double.isFinite(value))b.append(value);else b.append("null");}
    static String json(String s) {
        if(s==null)return "null"; StringBuilder b=new StringBuilder("\"");
        for(char c:s.toCharArray()) switch(c){case '"' -> b.append("\\\"");case '\\' -> b.append("\\\\");case '\n' -> b.append("\\n");case '\r' -> b.append("\\r");case '\t' -> b.append("\\t");default -> {if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}
        return b.append('"').toString();
    }
    void handle(HttpExchange x) throws IOException {
        try {
            if(!x.getRequestMethod().equals("GET")){x.getResponseHeaders().set("Allow","GET");send(x,405,"application/json","{\"error\":\"GET required\"}".getBytes(StandardCharsets.UTF_8));return;}
            String path=x.getRequestURI().getPath();
            if(path.equals("/api/gpus")) {
                long since=0; String query=x.getRequestURI().getRawQuery();
                if(query!=null)for(String p:query.split("&"))if(p.startsWith("since="))since=Long.parseLong(p.substring(6));
                send(x,200,"application/json",snapshot(true,since).getBytes(StandardCharsets.UTF_8));
            } else if(path.equals("/api/health")) {
                boolean ok; synchronized(this){ok=lastSuccess>0 && error==null && System.currentTimeMillis()-lastSuccess<10000;}
                send(x,ok?200:503,"application/json",("{\"ok\":"+ok+",\"demo\":"+demo+"}").getBytes(StandardCharsets.UTF_8));
            } else if(Set.of("/","/app.js","/style.css").contains(path)) {
                String file=path.equals("/")?"index.html":path.substring(1);
                try(InputStream in=Main.class.getResourceAsStream("/web/"+file)) {
                    if(in==null){send(x,404,"text/plain",new byte[0]);return;}
                    send(x,200,file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"text/html",in.readAllBytes());
                }
            } else send(x,404,"text/plain","Not found".getBytes(StandardCharsets.UTF_8));
        } catch(NumberFormatException e){send(x,400,"application/json","{\"error\":\"Invalid since timestamp\"}".getBytes(StandardCharsets.UTF_8));}
        finally{x.close();}
    }
    static void send(HttpExchange x,int status,String type,byte[] bytes)throws IOException {
        x.getResponseHeaders().set("Content-Type",type+"; charset=utf-8");x.getResponseHeaders().set("Cache-Control","no-store");
        x.getResponseHeaders().set("X-Content-Type-Options","nosniff");
        x.getResponseHeaders().set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'");
        x.sendResponseHeaders(status,bytes.length);x.getResponseBody().write(bytes);
    }
}
