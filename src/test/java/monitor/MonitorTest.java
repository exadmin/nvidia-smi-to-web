package monitor;

import java.io.IOException;
import java.nio.file.Path;
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
