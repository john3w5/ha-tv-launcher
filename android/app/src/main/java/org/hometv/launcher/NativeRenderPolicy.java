package org.hometv.launcher;

/** Native-pixel cache geometry; independent of Android so rounding and budget can be checked offline. */
public final class NativeRenderPolicy {
    private NativeRenderPolicy() {}

    public static final int DESIGN_WIDTH = 1440;
    public static final int DESIGN_HEIGHT = 810;
    public static final long MAX_LAYER_BYTES = 24L * 1024 * 1024;

    public static final class Bounds {
        public final int left, top, right, bottom, width, height;

        private Bounds(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.width = right - left;
            this.height = bottom - top;
        }

        private long rgbaBytes() {
            return multiplySaturated(multiplySaturated(width, height), 4L);
        }
    }

    public static final class Geometry {
        public final int viewWidth, viewHeight;
        public final float scale;
        public final Bounds background, content;
        /** RGBA content estimate for one backdrop and two retained page layers, excluding driver overhead. */
        public final long estimatedLayerBytes;
        /** False retains native-pixel vector display lists without forcing raster compositing layers. */
        public final boolean compositingAllowed;

        private Geometry(int viewWidth, int viewHeight, float scale, Bounds background, Bounds content) {
            this.viewWidth = viewWidth;
            this.viewHeight = viewHeight;
            this.scale = scale;
            this.background = background;
            this.content = content;
            this.estimatedLayerBytes = addSaturated(background.rgbaBytes(), multiplySaturated(content.rgbaBytes(), 2L));
            this.compositingAllowed = estimatedLayerBytes <= MAX_LAYER_BYTES;
        }
    }

    /**
     * Bounds are outward-rounded in physical pixels. Record with translate(-left, -top),
     * then scale(scale, scale); draw the node with the parent's design scale cancelled.
     * Positive viewport dimensions are required; no implicit scale clamp changes the geometry.
     */
    public static Geometry geometry(int viewWidth, int viewHeight) {
        if (viewWidth <= 0 || viewHeight <= 0) throw new IllegalArgumentException("Positive viewport required");
        float scale = Math.min(viewWidth / (float) DESIGN_WIDTH, viewHeight / (float) DESIGN_HEIGHT);
        return new Geometry(viewWidth, viewHeight, scale,
            new Bounds(0, 0, ceil(DESIGN_WIDTH * scale), ceil(DESIGN_HEIGHT * scale)),
            new Bounds(floor(24f * scale), floor(150f * scale), ceil(1416f * scale), ceil(796f * scale)));
    }

    // The float product matches the Canvas transform's coordinate precision before integer rounding.
    private static int floor(float value) { return (int) Math.floor(value); }
    private static int ceil(float value) { return (int) Math.ceil(value); }
    private static long multiplySaturated(long a, long b) {
        return a != 0 && b > Long.MAX_VALUE / a ? Long.MAX_VALUE : a * b;
    }
    private static long addSaturated(long a, long b) {
        return b > Long.MAX_VALUE - a ? Long.MAX_VALUE : a + b;
    }
}
