package org.hometv.launcher;

public final class NativeMediaPolicyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void reject(String base,String uri){try{NativeMediaPolicy.streamUrl(base,uri);throw new AssertionError("Unsafe stream accepted");}catch(IllegalArgumentException expected){checks++;}}
    public static void main(String[] args){
        String base="http://home-tv.local:4317/", path="/api/streams/a_B12/c-D34";
        check(NativeMediaPolicy.streamUrl(base,path).toString().equals("http://home-tv.local:4317"+path),"Relative opaque bridge URL");
        check(NativeMediaPolicy.streamUrl(base,"http://home-tv.local:4317"+path).getPort()==4317,"Own absolute URL");
        check(NativeMediaPolicy.streamUrl(base,path+".m3u8").getPath().endsWith(".m3u8"),"Exact HLS playlist alias keeps native type detection");
        reject(base,path+".mp4");reject(base,path+".m3u8.exe");reject(base,path+".m3u8?token=secret");
        check(NativeMediaPolicy.streamUrl("https://tv.example/","https://tv.example:443"+path).getPort()==443,"Same effective HTTPS origin");
        String[] bad={null,"", "https://evil.example"+path,"http://home-tv.local:4318"+path,"http://user:secret@home-tv.local:4317"+path,
            "//home-tv.local:4317"+path,path+"?token=secret",path+"#fragment","/api/streams/a/../a/b","/api/streams/%61/b","/api/streams/a/b%2fc",
            "file:///api/streams/a/b","content://tv/api/streams/a/b","/api/cameras/entrance/snapshot","/api/streams/a/b/extra","/api/streams/a/b\\evil","api/streams/a/b"};
        for(String uri:bad)reject(base,uri);
        reject("http://public.example/",path);reject("https://user:password@tv.example/",path);
        check(NativeMediaPolicy.cameraId("entrance")&&NativeMediaPolicy.cameraId("gate-1"),"Configured camera ID shape");
        check(!NativeMediaPolicy.cameraId("../entrance")&&!NativeMediaPolicy.cameraId(null),"Camera path cannot escape");
        check(NativeMediaPolicy.quality("smooth")&&NativeMediaPolicy.quality("hd")&&!NativeMediaPolicy.quality("auto"),"Only two quality values");
        NativeMediaPolicy lifecycle=new NativeMediaPolicy();
        long old=lifecycle.begin();check(lifecycle.current(old),"One active player");
        long next=lifecycle.begin();check(!lifecycle.current(old)&&lifecycle.current(next),"Quality/new camera invalidates old callbacks");
        lifecycle.end();check(!lifecycle.current(next),"Close/pause invalidates queued response");
        long resumed=lifecycle.begin();check(!lifecycle.current(old)&&lifecycle.current(resumed),"Reopen cannot resurrect older player");
        lifecycle.end();lifecycle.end();check(!lifecycle.current(resumed),"Cleanup is idempotent");
        check(NativeMediaPolicy.mediaUrl(base,"/media/family.mp4").getHost().equals("home-tv.local"),"Relative media stays on bridge");
        var remote=NativeMediaPolicy.mediaUrl(base,"https://cdn.example/movie.mp4?signature=example");
        check(!NativeMediaPolicy.sameOrigin(base,remote),"Third-party media must not receive household Cookie");
        check(NativeMediaPolicy.sameOrigin(base,NativeMediaPolicy.mediaUrl(base,"/media/family.mp4")),"Own media may receive own session Cookie");
        check(NativeMediaPolicy.mediaUrl(base,"http://10.0.0.2/audio.mp3").getHost().equals("10.0.0.2"),"Explicit LAN HTTP accepted by URL policy");
        for(String badMedia:new String[]{"http://public.example/movie.mp4","https://user:pass@cdn.example/movie.mp4","javascript:alert(1)","file:///video.mp4","//cdn.example/video.mp4","https://cdn.example/a\r\nCookie:x","https://cdn.example/a%0d%0aCookie:x","https://cdn.example/video.mp4#frag"}){
            try{NativeMediaPolicy.mediaUrl(base,badMedia);throw new AssertionError("Unsafe media accepted");}catch(IllegalArgumentException expected){checks++;}
        }
        check("audio".equals(NativeMediaPolicy.mediaKind("audio/mpeg")),"Native audio mode");
        check("video".equals(NativeMediaPolicy.mediaKind("application/vnd.apple.mpegurl")),"Native HLS video mode");
        check(NativeMediaPolicy.mediaKind("image/png")==null&&NativeMediaPolicy.mediaKind("intent://native")==null,"No image or intent treated as playable audio/video");
        System.out.println("NativeMediaPolicy: "+checks+" assertions passed.");
    }
}
