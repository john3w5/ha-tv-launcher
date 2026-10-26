package org.hometv.launcher;

public final class NativeRenderPolicyTest {
    private static int checks;
    private static void check(boolean ok, String message) {
        checks++;
        if (!ok) throw new AssertionError(message);
    }
    private static void near(double actual, double expected, double tolerance, String message) {
        check(Math.abs(actual - expected) <= tolerance, message + ": " + actual + " vs " + expected);
    }
    private static void bounds(NativeRenderPolicy.Bounds actual, int left, int top, int right, int bottom, String label) {
        check(actual.left == left && actual.top == top && actual.right == right && actual.bottom == bottom, label + " bounds");
        check(actual.width == right - left && actual.height == bottom - top, label + " dimensions");
    }

    public static void main(String[] args) {
        NativeRenderPolicy.Geometry hd = NativeRenderPolicy.geometry(1280, 720);
        near(hd.scale, 8.0 / 9.0, 0.000001, "HD keeps the exact fit scale");
        bounds(hd.background, 0, 0, 1280, 720, "HD backdrop");
        bounds(hd.content, 21, 133, 1259, 708, "HD content");
        check(hd.compositingAllowed, "HD retains three raster layers");

        NativeRenderPolicy.Geometry fhd = NativeRenderPolicy.geometry(1920, 1080);
        near(fhd.scale, 4.0 / 3.0, 0.000001, "FHD scale");
        bounds(fhd.background, 0, 0, 1920, 1080, "FHD backdrop");
        bounds(fhd.content, 32, 200, 1888, 1062, "FHD content");
        check(fhd.estimatedLayerBytes == 21093376L, "FHD's one backdrop and two pages estimate is 21,093,376 bytes");
        check(fhd.compositingAllowed, "FHD keeps the fast compositing path within 24 MiB");

        NativeRenderPolicy.Geometry uhd = NativeRenderPolicy.geometry(3840, 2160);
        bounds(uhd.background, 0, 0, 3840, 2160, "4K backdrop");
        bounds(uhd.content, 64, 400, 3776, 2123, "4K content");
        check(!uhd.compositingAllowed, "4K falls back to vector lists rather than reduced-resolution textures");
        check(uhd.estimatedLayerBytes > NativeRenderPolicy.MAX_LAYER_BYTES, "4K cannot force three raster layers inside the budget");

        NativeRenderPolicy.Geometry odd = NativeRenderPolicy.geometry(1919, 1079);
        bounds(odd.background, 0, 0, 1919, 1079, "Fractional backdrop");
        bounds(odd.content, 31, 199, 1887, 1061, "Fractional content");
        check(odd.scale < fhd.scale, "A one-pixel viewport change cannot reuse the former recording scale");
        NativeRenderPolicy.Geometry wide = NativeRenderPolicy.geometry(2560, 1080);
        check(wide.viewWidth == 2560 && wide.viewHeight == 1080, "Cache geometry retains the actual view dimensions");
        bounds(wide.background, 0, 0, 1920, 1080, "Pillarboxed backdrop");
        near(wide.scale, fhd.scale, 0, "Wider viewport keeps the same drawable design scale");
        NativeRenderPolicy.Geometry tall = NativeRenderPolicy.geometry(1920, 1200);
        bounds(tall.background, 0, 0, 1920, 1080, "Letterboxed backdrop");
        NativeRenderPolicy.Geometry tiny = NativeRenderPolicy.geometry(1, 1);
        check(tiny.scale < .01f && tiny.scale > 0, "No minimum scale silently enlarges a tiny viewport");
        check(tiny.compositingAllowed, "Tiny positive viewport has a bounded estimate");

        // Independent screen-space transform check: recording translate -> scale,
        // RenderNode bounds, cancelled parent scale, and the unchanged letterbox offset.
        for (int[] viewport : new int[][]{{1280, 720}, {1920, 1080}, {1919, 1079}, {2560, 1080}, {1920, 1200}, {3840, 2160}}) {
            NativeRenderPolicy.Geometry geometry = NativeRenderPolicy.geometry(viewport[0], viewport[1]);
            double offsetX = (viewport[0] - 1440f * geometry.scale) / 2f;
            double offsetY = (viewport[1] - 810f * geometry.scale) / 2f;
            for (float[] point : new float[][]{{24, 150}, {1416, 796}, {34, 162}, {720, 400}, {1406, 780}}) {
                double localX = point[0] * geometry.scale - geometry.content.left;
                double localY = point[1] * geometry.scale - geometry.content.top;
                check(localX >= 0 && localX <= geometry.content.width && localY >= 0 && localY <= geometry.content.height,
                    "Outward-rounded node contains transformed design point");
                double screenX = offsetX + geometry.content.left + localX;
                double screenY = offsetY + geometry.content.top + localY;
                near(screenX, offsetX + point[0] * geometry.scale, .00001, "Native-pixel node and direct rendering align in X");
                near(screenY, offsetY + point[1] * geometry.scale, .00001, "Native-pixel node and direct rendering align in Y");
                near((screenX - offsetX) / geometry.scale, point[0], .0002, "Remote/touch inverse X remains in virtual coordinates");
                near((screenY - offsetY) / geometry.scale, point[1], .0002, "Remote/touch inverse Y remains in virtual coordinates");
            }
        }

        // Exercise the crossover at nearby real 16:9 viewports rather than testing only HD/4K.
        boolean sawAllowed = false, sawDenied = false;
        for (int width = 1920; width <= 2304; width += 16) {
            NativeRenderPolicy.Geometry geometry = NativeRenderPolicy.geometry(width, width * 9 / 16);
            check(geometry.compositingAllowed == (geometry.estimatedLayerBytes <= 25165824L), "Three-layer estimate enforces a 24 MiB ceiling");
            if (geometry.compositingAllowed) sawAllowed = true;
            else sawDenied = true;
        }
        check(sawAllowed && sawDenied, "Nearby viewport sweep crosses the real memory limit");
        NativeRenderPolicy.Geometry extreme = NativeRenderPolicy.geometry(Integer.MAX_VALUE, Integer.MAX_VALUE);
        check(extreme.estimatedLayerBytes == Long.MAX_VALUE && !extreme.compositingAllowed,
            "Absurd dimensions saturate safely instead of wrapping into an allowed budget");
        for (int[] invalid : new int[][]{{0, 1080}, {1920, 0}, {-1, 1080}, {1920, -1}}) {
            try {
                NativeRenderPolicy.geometry(invalid[0], invalid[1]);
                throw new AssertionError("Nonpositive viewport accepted");
            } catch (IllegalArgumentException expected) {
                check(true, "Nonpositive viewport rejected");
            }
        }
        System.out.println("NativeRenderPolicy: " + checks + " assertions passed.");
    }
}
