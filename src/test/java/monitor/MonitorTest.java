package monitor;

import java.io.IOException;
import java.nio.file.Path;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.*;
import com.sun.net.httpserver.HttpServer;
import java.util.*;

public class MonitorTest {
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args) throws Exception {
        if(args.length>0){
            if(args[0].equals("sleep")){Thread.sleep(30000);return;}
            if(args[0].equals("fail")){System.err.print("driver unavailable");System.exit(7);}
            System.err.print("x".repeat(100_000));
            System.out.print("0, GPU-test, \"Tesla, P100\", 45, 1200, 715, 1024, 16384, 20, 90.5, 250, [N/A], 3, 16\n");return;
        }
        String row="0, GPU-test, \"Tesla, P100\", 45, 1200, 715, 1024, 16384, 20, 90.5, 250, [N/A], 3, 16";
        var parsed=Main.parse(row);
        check(parsed.size()==1 && parsed.get(0).name().equals("Tesla, P100"),"quoted CSV");
        check(Double.isNaN(parsed.get(0).values()[8]),"unsupported sensor");
        try{Main.parse("broken");throw new AssertionError("malformed CSV accepted");}catch(IOException expected){}
        try{Main.parse(row+"\n"+row);throw new AssertionError("duplicate UUID accepted");}catch(IOException expected){}
        Main.History h=new Main.History();long now=System.currentTimeMillis();
        for(int i=0;i<7300;i++)h.add(now-((7299-i)*2000L),parsed.get(0));
        check(h.size==7200 && h.times[h.next]==now-7199*2000L,"ring retains newest 7200");
        Main app=new Main("unused",false);
        try {
            app.cards.put("GPU-test",h);
            String json=app.snapshot(true,now-2000);
            check(json.contains("\"history\":[["+now+","),"incremental history");
            check(!json.contains("NaN") && json.contains("null"),"valid JSON null");
            HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/",app::handle);
            server.start();
            try(var client=HttpClient.newHttpClient()) {
                String base="http://127.0.0.1:"+server.getAddress().getPort()+"/api/runtime";
                var response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=temperature")).build(),HttpResponse.BodyHandlers.ofString());
                check(response.statusCode()==200 && response.body().equals("{\"gpus\":[\"GPU-test\"],\"temperature\":[\"45.0\"]}"),"runtime latest metric as string");
                response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=fan")).build(),HttpResponse.BodyHandlers.ofString());
                check(response.body().equals("{\"gpus\":[\"GPU-test\"],\"fan\":[null]}"),"runtime unavailable sensor");
                Main.History second=new Main.History();
                double[] values=parsed.get(0).values().clone();values[0]=60;values[8]=30;
                second.add(now,new Main.Reading(1,"GPU-second","Second GPU",values));
                app.cards.put("GPU-second",second);
                response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=temperature%2Cfan")).build(),HttpResponse.BodyHandlers.ofString());
                check(response.body().equals("{\"gpus\":[\"GPU-test\",\"GPU-second\"],\"temperature\":[\"45.0\",\"60.0\"],\"fan\":[null,\"30.0\"]}"),"runtime multiple metrics and GPUs in consistent order");
                second.lastSeen=now-15_000_000;
                response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=temperature")).build(),HttpResponse.BodyHandlers.ofString());
                check(response.body().equals("{\"gpus\":[\"GPU-test\"],\"temperature\":[\"45.0\"]}"),"runtime excludes expired GPU");
                for(String suffix:List.of("","?metrics=unknown","?metrics=temperature,unknown","?metrics=","?metrics=temperature,","?metric=temperature")) {
                    response=client.send(HttpRequest.newBuilder(URI.create(base+suffix)).build(),HttpResponse.BodyHandlers.ofString());
                    check(response.statusCode()==400,"runtime rejects missing or unknown metric");
                }
                response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=temperature")).POST(HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString());
                check(response.statusCode()==405,"runtime GET only");
                app.cards.clear();
                response=client.send(HttpRequest.newBuilder(URI.create(base+"?metrics=temperature")).build(),HttpResponse.BodyHandlers.ofString());
                check(response.body().equals("{\"gpus\":[],\"temperature\":[]}"),"runtime before first sample");
                app.cards.put("GPU-test",h);
            } finally {server.stop(0);}
            h.lastSeen=now-15_000_000;check(app.snapshot(true,0).contains("\"cards\":[]"),"expiry");
            String java=Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"java.exe":"java").toString();
            List<String> command=List.of(java,"-cp",System.getProperty("java.class.path"),MonitorTest.class.getName(),"output");
            check(Main.parse(app.runCommand(command,5)).size()==1,"process stdout and concurrent stderr drain");
            for(String mode:List.of("fail","sleep")){
                var cmd=new ArrayList<>(command);cmd.set(cmd.size()-1,mode);
                long start=System.nanoTime();
                try{app.runCommand(cmd,1);throw new AssertionError("process failure accepted");}
                catch(IOException expected){check(expected.getMessage().contains(mode.equals("fail")?"exit 7":"timed out"),"process error detail");}
                check((System.nanoTime()-start)/1e9<5,"bounded process termination");
            }
        } finally{app.io.close();app.sampler.shutdownNow();}
        System.out.println("PASS: CSV, missing sensors, ring, expiry, incremental JSON, process output/error/timeout");
    }
}
