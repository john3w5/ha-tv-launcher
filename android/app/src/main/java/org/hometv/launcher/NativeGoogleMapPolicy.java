package org.hometv.launcher;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Purpose-bound Google map resources, with no local dashboard origin. */
public final class NativeGoogleMapPolicy {
    private NativeGoogleMapPolicy() {}
    public static final String WRAPPER_URL = "https://appassets.androidplatform.net/home-tv/map/index.html";
    private static final Set<String> RESOURCES = Set.of(
        "www.google.com", "maps.google.com", "maps.gstatic.com", "www.gstatic.com",
        "fonts.gstatic.com", "fonts.googleapis.com", "maps.googleapis.com",
        "streetviewpixels-pa.googleapis.com", "khms0.googleapis.com", "khms1.googleapis.com",
        "mts0.googleapis.com", "mts1.googleapis.com"
    );

    public static boolean coordinates(double latitude, double longitude) {
        return Double.isFinite(latitude) && Double.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
    }

    public static String mapUrl(double latitude, double longitude, int zoom) {
        if (!coordinates(latitude, longitude)) throw new IllegalArgumentException("Map position unavailable");
        return String.format(Locale.ROOT, "https://www.google.com/maps?q=%.6f,%.6f&z=%d&hl=cs&output=embed", latitude, longitude, Math.max(3, Math.min(19, zoom)));
    }

    /** Documented keyless consumer Maps URL. Legacy output=embed is not the Embed API contract. */
    public static String standardMapUrl(double latitude, double longitude, int zoom) {
        if (!coordinates(latitude, longitude)) throw new IllegalArgumentException("Map position unavailable");
        return String.format(Locale.ROOT, "https://www.google.com/maps/@?api=1&map_action=map&center=%.6f%%2C%.6f&zoom=%d&basemap=roadmap&hl=cs", latitude, longitude, Math.max(3, Math.min(19, zoom)));
    }

    /** One owned virtual asset; no query, fragment, file, HA route or other local origin. */
    public static boolean wrapperPage(String raw) {
        URI uri = parse(raw);
        return uri != null && "appassets.androidplatform.net".equals(uri.getHost()) &&
            "/home-tv/map/index.html".equals(uri.getPath()) && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }

    public static String mapWrapperHtml(String googleMapUrl) {
        if (!mapNavigation(googleMapUrl)) throw new IllegalArgumentException("Google map unavailable");
        String source = googleMapUrl.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;");
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=960\">" +
            "<title>Google Mapy</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eef1f5}" +
            "iframe{display:block;border:0;width:100%;height:100%}</style></head><body>" +
            "<iframe id=\"home-tv-map-frame\" title=\"Google Mapy\" referrerpolicy=\"strict-origin-when-cross-origin\" " +
            "src=\"" + source + "\" onload=\"document.documentElement.setAttribute('data-map-frame-loaded','1')\" allowfullscreen></iframe></body></html>";
    }

    /** Own iframe load/geometry only. It deliberately cannot assert cross-origin map rendering. */
    public static String wrapperReadinessScript() {
        return "(function(){try{var f=document.getElementById('home-tv-map-frame');var r=f?f.getBoundingClientRect():{width:0,height:0};" +
            "var state=document.readyState==='complete'?3:document.readyState==='interactive'?2:1;" +
            "var loaded=!!f&&state>=2&&r.width>=200&&r.height>=200&&document.documentElement.getAttribute('data-map-frame-loaded')==='1';" +
            "return[loaded?64:0,Math.min(8192,Math.max(0,Math.round(r.width))),Math.min(8192,Math.max(0,Math.round(r.height))),state," +
            "document.body?Math.min(4095,document.body.childElementCount):0,0,0,0,0,f?1:0,0,0];" +
            "}catch(e){return[0,0,0,0,0,0,0,0,0,0,0,1];}})()";
    }

    /** Only Google embed HTML, never JS, icons, tiles, RPCs or arbitrary map subresources. */
    public static boolean embedDocument(String raw) {
        URI uri = parse(raw);
        if (uri == null || !mapNavigation(raw)) return false;
        if ("/maps/embed".equals(uri.getPath())) return true;
        if (!("/maps".equals(uri.getPath()) || "/maps/".equals(uri.getPath())) || uri.getRawQuery() == null) return false;
        int outputs = 0;
        try {
            for (String part : uri.getRawQuery().split("&")) {
                int split = part.indexOf('=');
                String name = java.net.URLDecoder.decode(split < 0 ? part : part.substring(0, split), java.nio.charset.StandardCharsets.UTF_8);
                if (!"output".equals(name)) continue;
                if (split < 0 || !"embed".equals(java.net.URLDecoder.decode(part.substring(split + 1), java.nio.charset.StandardCharsets.UTF_8))) return false;
                outputs++;
            }
        } catch (IllegalArgumentException invalid) { return false; }
        return outputs == 1;
    }

    /** Desktop-site compatibility for this map only, retaining the installed engine versions. */
    public static String desktopUserAgent(String actualDefault) {
        if (!validUserAgent(actualDefault)) return null;
        String chrome = productVersion(actualDefault, "Chrome");
        String webkit = productVersion(actualDefault, "AppleWebKit");
        String safari = productVersion(actualDefault, "Safari");
        if (chrome == null || webkit == null || safari == null) return null;
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/" + webkit +
            " (KHTML, like Gecko) Chrome/" + chrome + " Safari/" + safari;
    }

    private static boolean validUserAgent(String agent) {
        return agent != null && !agent.isEmpty() && agent.length() <= 2048 && agent.chars().noneMatch(c -> c < 32 || c > 126);
    }

    private static String productVersion(String agent, String product) {
        Matcher match = Pattern.compile("\\b" + Pattern.quote(product) + "/([0-9]{1,4}(?:\\.[0-9]{1,6}){1,3})(?=[ ;)]|$)").matcher(agent);
        if (!match.find()) return null;
        String result = match.group(1);
        return match.find() ? null : result;
    }

    /** Numeric UA hints only: Android=1, Mobile=2, WebView marker=4; never log the agent. */
    public static int userAgentFlags(String agent) {
        if (!validUserAgent(agent)) return 0;
        boolean android = Pattern.compile("\\bAndroid\\b", Pattern.CASE_INSENSITIVE).matcher(agent).find();
        boolean mobile = Pattern.compile("\\bMobile\\b", Pattern.CASE_INSENSITIVE).matcher(agent).find();
        boolean webview = Pattern.compile("\\bwv\\b", Pattern.CASE_INSENSITIVE).matcher(agent).find() || android && agent.contains("Version/4.0");
        return (android ? 1 : 0) | (mobile ? 2 : 0) | (webview ? 4 : 0);
    }

    private static URI parse(String raw) {
        if (raw == null || raw.length() > 16384 || raw.chars().anyMatch(c -> c < 32 || c == 127 || c == '\\')) return null;
        try {
            URI uri = URI.create(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.isOpaque() || uri.getHost() == null || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            return uri;
        } catch (Exception ignored) { return null; }
    }

    public static boolean navigation(String raw) {
        return wrapperPage(raw) || mapNavigation(raw) || consentPage(raw);
    }

    private static boolean mapNavigation(String raw) {
        URI uri = parse(raw);
        if (uri == null || !("www.google.com".equals(uri.getHost()) || "maps.google.com".equals(uri.getHost()))) return false;
        String p = uri.getPath();
        return p != null && (p.equals("/maps") || p.startsWith("/maps/"));
    }

    /** Google's own consent page is allowed only when it continues to this Maps surface. */
    public static boolean consentPage(String raw) {
        URI uri = parse(raw);
        if (uri == null || !"consent.google.com".equals(uri.getHost()) ||
                !("/m".equals(uri.getPath()) || "/ml".equals(uri.getPath())) || uri.getRawQuery() == null) return false;
        String continuation = null;
        try {
            for (String item : uri.getRawQuery().split("&")) {
                int split = item.indexOf('=');
                String key = java.net.URLDecoder.decode(split < 0 ? item : item.substring(0, split), java.nio.charset.StandardCharsets.UTF_8);
                if (!"continue".equals(key)) continue;
                if (continuation != null || split < 0) return false;
                continuation = java.net.URLDecoder.decode(item.substring(split + 1), java.nio.charset.StandardCharsets.UTF_8);
            }
        } catch (IllegalArgumentException invalid) { return false; }
        return mapNavigation(continuation);
    }

    /** Used only while the visible main page is a validated Maps consent continuation. */
    public static boolean consentPostResource(String raw) {
        URI uri = parse(raw);
        return uri != null && "consent.google.com".equals(uri.getHost()) && "/save".equals(uri.getPath());
    }

    public static boolean resource(String raw) {
        if (consentPage(raw)) return true;
        URI uri = parse(raw);
        if (uri == null || !RESOURCES.contains(uri.getHost())) return false;
        String p = uri.getPath();
        if (p == null || p.startsWith("/accounts") || p.startsWith("/signin") || p.startsWith("/ServiceLogin") || p.equals("/gen_204")) return false;
        return !("www.google.com".equals(uri.getHost()) || "maps.google.com".equals(uri.getHost())) || p.startsWith("/maps") || p.startsWith("/js/");
    }

    /** Maps' own JSON RPC requires POST; it never targets a local origin or a sign-in service. */
    public static boolean postResource(String raw) {
        URI uri = parse(raw);
        if (uri == null || !resource(raw)) return false;
        String host = uri.getHost(), path = uri.getPath();
        return ("maps.googleapis.com".equals(host) && (path.startsWith("/$rpc/") || path.startsWith("/maps/"))) ||
            (("www.google.com".equals(host) || "maps.google.com".equals(host)) && path.startsWith("/maps/"));
    }

    /** Browser-managed CORS preflight only for the already-allowed Maps JSON RPC origin/path. */
    public static boolean preflightResource(String raw) {
        URI uri = parse(raw);
        return uri != null && postResource(raw) && "maps.googleapis.com".equals(uri.getHost()) &&
            uri.getPath().startsWith("/$rpc/");
    }

    /** Keep the real Maps page referrer; replacing it with Google's root breaks its restricted key. */
    public static String referrer(String candidate, String currentMap) {
        return navigation(candidate) ? candidate : navigation(currentMap) ? currentMap : null;
    }

    /** Diagnostic categories only; the caller must never log the URL or its query. */
    public static int hostClass(String raw) {
        URI uri = parse(raw);
        if (uri == null) return 0;
        String host = uri.getHost();
        if (wrapperPage(raw)) return 10;
        if ("www.google.com".equals(host) || "maps.google.com".equals(host)) return 1;
        if ("consent.google.com".equals(host)) return 2;
        if ("accounts.google.com".equals(host)) return 3;
        if ("maps.gstatic.com".equals(host) || "www.gstatic.com".equals(host) || "fonts.gstatic.com".equals(host)) return 4;
        if (RESOURCES.contains(host)) return 5;
        // Diagnostic categories do not grant these hosts resource access.
        if (Set.of("khm0.google.com", "khm1.google.com", "mts0.google.com", "mts1.google.com").contains(host)) return 6;
        if (Set.of("maps.googleusercontent.com", "lh3.googleusercontent.com", "lh4.googleusercontent.com").contains(host)) return 7;
        if (Set.of("geo0.ggpht.com", "geo1.ggpht.com", "geo2.ggpht.com", "geo3.ggpht.com").contains(host)) return 8;
        return 9;
    }

    /** Fixed path/type buckets only: script, style, tile, RPC, image, font, consent, document, other. */
    public static int resourceClass(String raw) {
        URI uri = parse(raw);
        if (uri == null) return 0;
        String path = uri.getPath();
        if (path == null) return 9;
        path = path.toLowerCase(Locale.ROOT);
        if ("consent.google.com".equals(uri.getHost())) return 7;
        if (path.startsWith("/$rpc/") || path.contains("/batchexecute") || path.contains("/rpc/")) return 4;
        if (path.endsWith(".js") || path.startsWith("/maps-api-v3/") || path.startsWith("/js/") ||
                path.startsWith("/xjs/") || path.equals("/maps/api/js") || path.contains("/_/js/")) return 1;
        if (path.endsWith(".css") || "fonts.googleapis.com".equals(uri.getHost())) return 2;
        if (path.contains("/vt") || path.contains("/kh/")) return 3;
        if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") || path.endsWith(".webp") || path.endsWith(".gif") || path.endsWith(".svg")) return 5;
        if (path.endsWith(".woff") || path.endsWith(".woff2") || path.endsWith(".ttf")) return 6;
        return navigation(raw) ? 8 : 9;
    }

    /** Why an isolated request is denied; never return host names, paths, queries or headers. */
    public static int blockedReason(String raw, String method, boolean consentVisible) {
        if ("GET".equals(method) && resource(raw) || "POST".equals(method) &&
                (postResource(raw) || consentVisible && consentPostResource(raw)) ||
                "OPTIONS".equals(method) && preflightResource(raw)) return 0;
        URI uri = parse(raw);
        if (uri == null) return 1;
        if (!"GET".equals(method) && !"POST".equals(method) && !"OPTIONS".equals(method)) return 4;
        if (consentPostResource(raw) && !consentVisible) return 5;
        if (!RESOURCES.contains(uri.getHost()) && !consentPage(raw)) return 2;
        return 3;
    }

    /** Read-only bounded DOM counts. A loaded container is readiness evidence, never pixel proof. */
    public static String readinessScript() {
        return "(function(){try{var cap=function(n){return Math.min(4095,Math.max(0,n||0));};" +
            "var state=document.readyState==='complete'?3:document.readyState==='interactive'?2:document.readyState==='loading'?1:0;" +
            "var m=document.querySelector('.gm-style')||document.querySelector('.widget-scene')||document.querySelector('#mapDiv')||document.querySelector('#scene');" +
            "var r=m?m.getBoundingClientRect():{width:0,height:0};var drawable=0;var fallback=0;" +
            "if(!m&&state>=2){var vw=Number(window.innerWidth)||document.documentElement.clientWidth;var vh=Number(window.innerHeight)||document.documentElement.clientHeight;" +
            "var cs=document.getElementsByTagName('canvas');var best=0;for(var k=0;k<Math.min(cs.length,64);k++){var c=cs[k];if(!(c.width>1&&c.height>1))continue;" +
            "var cr=c.getBoundingClientRect();var left=Math.max(0,cr.left),top=Math.max(0,cr.top),right=Math.min(vw,cr.right),bottom=Math.min(vh,cr.bottom);var visible=true;" +
            "for(var a=c,depth=0;a&&depth<16;a=a.parentElement,depth++){var s=window.getComputedStyle(a);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.opacity!==''&&s.opacity!=null&&Number(s.opacity)<=0){visible=false;break;}" +
            "if(a!==c&&(s.overflowX==='hidden'||s.overflowX==='clip'||s.overflowX==='scroll'||s.overflowX==='auto'||s.overflowY==='hidden'||s.overflowY==='clip'||s.overflowY==='scroll'||s.overflowY==='auto')){" +
            "var ar=a.getBoundingClientRect();if(s.overflowX!=='visible'){left=Math.max(left,ar.left);right=Math.min(right,ar.right);}if(s.overflowY!=='visible'){top=Math.max(top,ar.top);bottom=Math.min(bottom,ar.bottom);}}}" +
            "var w=right-left,h=bottom-top;if(!visible||w<200||h<100||w*h<=best)continue;best=w*h;m=c.parentElement||c;drawable=1;fallback=32;" +
            "var pr=m.getBoundingClientRect();r={width:Math.min(vw,Math.max(w,Math.min(vw,pr.right)-Math.max(0,pr.left))),height:Math.min(vh,Math.max(h,Math.min(vh,pr.bottom)-Math.max(0,pr.top)))};}}" +
            "if(!fallback){var nodes=m?m.querySelectorAll('img,canvas'):[];for(var i=0;i<Math.min(nodes.length,256);i++){var n=nodes[i];if(n.tagName==='CANVAS'?n.width>1&&n.height>1:n.complete&&n.naturalWidth>16&&n.naturalHeight>16)drawable++;}}" +
            "var imgs=document.images||[];var loaded=0;for(var j=0;j<Math.min(imgs.length,256);j++){var img=imgs[j];if(img.complete&&img.naturalWidth>0)loaded++;}" +
            "var e=document.querySelector('.gm-err-container');var flags=(m?1:0)+(r.width>1?2:0)+(r.height>1?4:0)+(drawable>0?8:0)+(e?16:0)+fallback;" +
            "var perf=typeof performance!=='undefined'&&performance.getEntriesByType?performance.getEntriesByType('resource').length:0;" +
            "return[flags,Math.min(8192,Math.max(0,Math.round(r.width))),Math.min(8192,Math.max(0,Math.round(r.height))),state," +
            "cap(document.body?document.body.childElementCount:0),cap(imgs.length),cap(loaded),cap(document.getElementsByTagName('canvas').length)," +
            "cap(document.scripts?document.scripts.length:0),cap(document.getElementsByTagName('iframe').length),cap(perf),0];" +
            "}catch(e){return[0,0,0,0,0,0,0,0,0,0,0,1];}})()";
    }

    public static int consoleErrorCode(String message) {
        if (message == null) return 0;
        String[] names = {"ReferenceError", "TypeError", "SyntaxError", "SecurityError", "Content Security Policy", "CORS policy", "WebGL"};
        for (int i = 0; i < names.length; i++) if (message.contains(names[i])) return i + 1;
        return 0;
    }

    /** Fixed public error names become numeric codes; arbitrary console text never leaves the WebView. */
    public static int googleErrorCode(String message) {
        if (message == null) return 0;
        String[] names = {"RefererNotAllowedMapError", "MissingKeyMapError", "InvalidKeyMapError", "ApiNotActivatedMapError",
            "ApiTargetBlockedMapError", "DeletedApiProjectMapError", "ExpiredKeyMapError", "OverQuotaMapError", "BillingNotEnabledMapError"};
        for (int i = 0; i < names.length; i++) if (message.contains(names[i])) return i + 1;
        return 0;
    }

    /** Only the current main-page request may change loading/error state after a fallback. */
    public static boolean samePage(String current, String reported) {
        URI a = parse(current), b = parse(reported);
        return a != null && b != null && navigation(current) && navigation(reported) &&
            a.getHost().equals(b.getHost()) && a.getPath().equals(b.getPath()) &&
            java.util.Objects.equals(a.getQuery(), b.getQuery());
    }
}
