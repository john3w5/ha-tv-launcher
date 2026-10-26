package org.hometv.launcher;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TimeZone;
import java.util.regex.Pattern;

/** UI-thread projection: timestamps are parsed only when actual calendar content changes. */
public final class NativeCalendarProjection {
    public static final class Source {
        public final String title, calendar, start, end;
        public Source(String title, String calendar, String start, String end) {
            this.title = title; this.calendar = calendar; this.start = start; this.end = end;
        }
        @Override public boolean equals(Object other) {
            if (!(other instanceof Source)) return false;
            Source value = (Source) other;
            return Objects.equals(title, value.title) && Objects.equals(calendar, value.calendar) &&
                Objects.equals(start, value.start) && Objects.equals(end, value.end);
        }
        @Override public int hashCode() { return Objects.hash(title, calendar, start, end); }
    }
    public static final class Event {
        public final String title, calendar, dateLabel, timeLabel;
        public final long start;
        public final Long end;
        public final boolean allDay;
        private Event(Source source, long start, Long end, boolean allDay, String dateLabel, String timeLabel) {
            this.title = source.title; this.calendar = source.calendar; this.start = start;
            this.end = end; this.allDay = allDay; this.dateLabel = dateLabel; this.timeLabel = timeLabel;
        }
    }
    public static final class Day {
        public final String key, shortLabel, longLabel;
        public final long start, end;
        private Day(String key, String shortLabel, String longLabel, long start, long end) {
            this.key = key; this.shortLabel = shortLabel; this.longLabel = longLabel; this.start = start; this.end = end;
        }
    }
    public static final class Occurrence {
        public final Event event;
        public final Day day;
        private Occurrence(Event event, Day day) { this.event = event; this.day = day; }
    }

    private final Locale locale = new Locale("cs", "CZ");
    private final TimeZone zone = TimeZone.getTimeZone("Europe/Prague");
    private final Calendar clock = Calendar.getInstance(zone, locale);
    private final Map<String, SimpleDateFormat> formats = new LinkedHashMap<>();
    private final List<SimpleDateFormat> parsers = new ArrayList<>();
    private static final Pattern OFFSET = Pattern.compile("([+-]\\d{2}):(\\d{2})$");
    private final LinkedHashMap<String, Long> parsed = new LinkedHashMap<String, Long>(128, .75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) { return size() > 128; }
    };
    private List<Source> sources = Collections.emptyList();
    private List<Event> events = Collections.emptyList();
    private List<Day> days = Collections.emptyList();
    private List<Occurrence> week = Collections.emptyList();
    private final Map<String, List<Occurrence>> byDay = new LinkedHashMap<>();
    private boolean available;
    private int dayKey = Integer.MIN_VALUE;
    private int contentVersion, occurrenceVersion = -1;

    public NativeCalendarProjection() {
        for (String pattern : new String[]{"yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mmZ", "yyyy-MM-dd"}) {
            SimpleDateFormat parser = new SimpleDateFormat(pattern, locale);
            parser.setLenient(false); parser.setTimeZone(zone); parsers.add(parser);
        }
    }

    /** Availability is separate from event equality, so an unavailable empty calendar updates promptly. */
    public boolean bind(List<Source> values, boolean nextAvailable) {
        if (values.size() > 4096) throw new IllegalArgumentException("Calendar projection exceeds bound");
        boolean changed = available != nextAvailable || !sources.equals(values);
        if (!changed) return false;
        available = nextAvailable;
        sources = Collections.unmodifiableList(new ArrayList<>(values));
        List<Event> next = new ArrayList<>();
        for (Source source : sources) {
            Long start = parse(source.start), end = parse(source.end);
            if (start == null || end != null && end < start) continue;
            boolean allDay = source.start.length() == 10;
            next.add(new Event(source, start, end, allDay, format(start, "EEE d. M."), allDay ? "Celý den" : format(start, "HH:mm")));
        }
        next.sort(Comparator.comparingLong(value -> value.start));
        events = Collections.unmodifiableList(next); contentVersion++;
        return true;
    }

    public boolean available(boolean live) { return live && available; }
    public List<Event> events(boolean live) { return live ? events : Collections.emptyList(); }
    public List<Day> days(long now) { ensureDays(now); return days; }
    public List<Occurrence> occurrences(long now, String selectedDay, boolean live) {
        ensureDays(now);
        if (!live) return Collections.emptyList();
        if (occurrenceVersion != contentVersion) {
            byDay.clear(); List<Occurrence> nextWeek = new ArrayList<>();
            for (Day day : days) {
                List<Occurrence> rows = new ArrayList<>();
                for (Event event : events) {
                    boolean overlaps = event.end == null ? event.start >= day.start && event.start < day.end : event.start < day.end && event.end > day.start;
                    if (overlaps) rows.add(new Occurrence(event, day));
                }
                List<Occurrence> immutable = Collections.unmodifiableList(rows);
                byDay.put(day.key, immutable); nextWeek.addAll(immutable);
            }
            week = Collections.unmodifiableList(nextWeek); occurrenceVersion = contentVersion;
        }
        return selectedDay == null ? week : byDay.getOrDefault(selectedDay, Collections.emptyList());
    }

    private void ensureDays(long now) {
        clock.setTimeInMillis(now);
        int key = clock.get(Calendar.YEAR) * 10000 + (clock.get(Calendar.MONTH) + 1) * 100 + clock.get(Calendar.DATE);
        if (key == dayKey) return;
        dayKey = key; clock.set(Calendar.HOUR_OF_DAY, 0); clock.set(Calendar.MINUTE, 0); clock.set(Calendar.SECOND, 0); clock.set(Calendar.MILLISECOND, 0);
        List<Day> next = new ArrayList<>(7);
        for (int i = 0; i < 7; i++) {
            long start = clock.getTimeInMillis(); clock.add(Calendar.DATE, 1); long end = clock.getTimeInMillis();
            next.add(new Day(format(start, "yyyy-MM-dd"), format(start, "EEE d."), format(start, "EEEE d. MMMM"), start, end));
        }
        days = Collections.unmodifiableList(next); occurrenceVersion = -1;
    }

    /** Also reused for the few non-calendar timestamp labels; failed parses are cached and bounded. */
    public Long parse(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 128) return null;
        if (parsed.containsKey(raw)) return parsed.get(raw);
        String value = OFFSET.matcher(raw).replaceFirst("$1$2");
        if (value.endsWith("Z")) value = value.substring(0, value.length() - 1) + "+0000";
        Long result = null;
        for (SimpleDateFormat parser : parsers) {
            // SimpleDateFormat.parse updates its calendar's zone from an explicit offset.
            parser.setTimeZone(zone);
            ParsePosition position = new ParsePosition(0); Date date = parser.parse(value, position);
            if (date != null && position.getIndex() == value.length()) { result = date.getTime(); break; }
        }
        parsed.put(raw, result); return result;
    }
    private String format(long time, String pattern) {
        SimpleDateFormat formatter = formats.get(pattern);
        if (formatter == null) { formatter = new SimpleDateFormat(pattern, locale); formatter.setTimeZone(zone); formats.put(pattern, formatter); }
        return formatter.format(new Date(time));
    }
}
