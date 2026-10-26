package org.hometv.launcher;

public final class NativeHlsRequestPolicyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    public static void main(String[] args) {
        String base="http://home-tv.local:4317/", path="/api/streams/a_B12/c-D34.m3u8";
        check(NativeHlsRequestPolicy.requestUrl(base,path,true)!=null,"Initial HLS URL");
        String[] valid={"_HLS_msn=0","_HLS_msn=2147483647&_HLS_part=10000&_HLS_skip=v2","_HLS_skip=YES","_HLS_part=0&_HLS_msn=123"};
        for(String query:valid)check(NativeHlsRequestPolicy.requestUrl(base,path+"?"+query,true).getRawQuery().equals(query),"LL-HLS query preserved");
        String[] invalid={"","_HLS_msn=2147483648","_HLS_part=10001","_HLS_part=-1","_HLS_msn=1.0","_HLS_msn=1e2","_HLS_skip=yes","_HLS_skip=NO","_HLS_msn=1&_HLS_msn=2","token=secret","_HLS_part=%31","_HLS_part=1&","_HLS_part=1=2","_HLS_part=999999999999999999999999"};
        for(String query:invalid)check(NativeHlsRequestPolicy.requestUrl(base,path+"?"+query,true)==null,"Unsafe reload rejected");
        check(NativeHlsRequestPolicy.requestUrl(base,"https://evil.example"+path+"?_HLS_msn=1",true)==null,"Reload cannot move to foreign origin");
        check(NativeHlsRequestPolicy.requestUrl(base,"/api/cameras/entrance/snapshot?_HLS_msn=1",true)==null,"Reload cannot change endpoint");
        check(NativeHlsRequestPolicy.requestUrl(base,path+"?_HLS_msn=1#fragment",true)==null,"No fragment");
        check(NativeHlsRequestPolicy.requestUrl(base,"https://user:pass@home-tv.local:4317"+path,true)==null,"No credentials");
        check(NativeHlsRequestPolicy.requestUrl(base,"https://cdn.example/video.mp4?signature=example",false)!=null,"Ordinary media signed URL supported");
        check(NativeHlsRequestPolicy.requestUrl(base,"file:///video.mp4",false)==null,"Ordinary media remains HTTP only");
        check(NativeHlsRequestPolicy.requestUrl(base,null,true)==null,"Null input fails closed");
        check(NativeHlsRequestPolicy.requestUrl(base,null,false)==null,"Null media fails closed");
        System.out.println("NativeHlsRequestPolicy: "+checks+" assertions passed.");
    }
}
