package org.hometv.launcher;

import java.util.ArrayList;
import java.util.List;

public final class NativeCalendarProjectionTest {
    private static int checks;
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    private static NativeCalendarProjection.Source source(String title, String start, String end) {
        return new NativeCalendarProjection.Source(title, "Rodina", start, end);
    }
    public static void main(String[] args) {
        NativeCalendarProjection p = new NativeCalendarProjection();
        long saturday = p.parse("2026-10-24T12:00:00+02:00");
        List<NativeCalendarProjection.Source> input = List.of(
            source("Celý den", "2026-10-25", "2026-10-26"),
            source("Večer přes půlnoc", "2026-10-24T23:30:00+02:00", "2026-10-25T02:30:00+01:00"),
            source("Krátká schůzka", "2026-10-26T14:15:00+01:00", "2026-10-26T15:00:00+01:00"),
            source("Neplatný konec", "2026-10-26T15:00:00+01:00", "2026-10-26T14:00:00+01:00"),
            source("Neplatný den", "2026-02-29", "2026-03-01"));
        check(p.bind(input, true), "First real content builds a projection");
        check(p.available(true) && !p.available(false), "Freshness gates calendar availability");
        List<NativeCalendarProjection.Event> events = p.events(true);
        check(events.size() == 3 && events.get(0).title.equals("Večer přes půlnoc"), "Events are strictly parsed, validated and sorted");
        check(events.get(1).allDay && events.get(1).timeLabel.equals("Celý den"), "All-day events retain their label");
        check(events.get(2).timeLabel.equals("14:15"), "Timed events use local Czech time");
        check(events.get(1).dateLabel.contains("25. 10."), "Overview date is preformatted and remains visible");
        check(!p.bind(new ArrayList<>(input), true), "New JSON container with identical content does not rebuild");
        check(events == p.events(true), "An unrelated power refresh retains the event projection identity");
        List<NativeCalendarProjection.Day> days = p.days(saturday);
        check(days.size() == 7 && days.get(0).key.equals("2026-10-24"), "Week begins on the Prague local day");
        check(days.get(1).end - days.get(1).start == 25 * 3600000L, "Autumn DST day lasts 25 hours");
        check(days == p.days(saturday + 10000), "Animation frames reuse day labels and boundaries");
        List<NativeCalendarProjection.Occurrence> week = p.occurrences(saturday, null, true);
        check(week.size() == 4, "A midnight-spanning event appears on both affected days");
        check(p.occurrences(saturday, "2026-10-25", true).size() == 2, "Selected local day returns cached overlaps");
        check(p.occurrences(saturday, "2026-10-26", true).size() == 1, "All-day end remains exclusive");
        check(week == p.occurrences(saturday + 1000, null, true), "Calendar animation does not recreate occurrences");
        check(p.events(false).isEmpty() && p.occurrences(saturday, null, false).isEmpty(), "Lost or stale connection never exposes cached events as live");
        check(week == p.occurrences(saturday, null, true), "A fresh reconnect can reuse unchanged projection data");
        List<NativeCalendarProjection.Source> renamed = new ArrayList<>(input);
        renamed.set(0, source("Změna názvu", "2026-10-25", "2026-10-26"));
        check(p.bind(renamed, true), "A real event title change invalidates the calendar");
        check(p.events(true).get(1).title.equals("Změna názvu"), "Changed event content is immediately projected");
        check(week != p.occurrences(saturday, null, true), "Actual content changes rebuild occurrences");
        check(p.bind(renamed, false) && !p.available(true), "Availability changes invalidate independently from event values");
        p.bind(renamed, true);
        long monday = p.parse("2026-10-25T23:30:00Z");
        check(p.days(monday).get(0).key.equals("2026-10-26"), "UTC near midnight selects the actual Prague date");
        check(p.days(monday) != days, "Prague midnight invalidates cached week boundaries");
        check(p.occurrences(monday, null, true).size() == 1, "Rolling week drops events from previous local days");
        long spring = p.parse("2026-03-28T12:00:00+01:00");
        check(p.days(spring).get(1).end - p.days(spring).get(1).start == 23 * 3600000L, "Spring DST day lasts 23 hours");
        check(p.parse("2026-10-25T01:30:00Z").equals(p.parse("2026-10-25T02:30:00+01:00")), "Explicit ISO offsets are interpreted correctly");
        check(p.parse("2026-10-25T02:30:00+02:00") + 3600000L == p.parse("2026-10-25T02:30:00+01:00"), "Repeated local DST hour preserves its explicit offset");
        check(p.parse("2026-10-25") == p.parse("2026-10-25T00:00:00+02:00").longValue(), "Date-only parse resets timezone after explicit offset parsing");
        for (String invalid : new String[]{"", "invalid", "2026-02-29", "2026-10-25garbage", "2026-13-01", "2026-10-25T25:00:00Z"}) {
            check(p.parse(invalid) == null && p.parse(invalid) == null, "Invalid date stays invalid even on cache hit");
        }
        List<NativeCalendarProjection.Source> bounded = new ArrayList<>();
        for (int i = 0; i < 4096; i++) bounded.add(source("Událost " + i, "2026-10-25", "2026-10-26"));
        check(p.bind(bounded, true) && p.events(true).size() == 4096, "Maximum bounded calendar input remains supported");
        List<NativeCalendarProjection.Occurrence> cached = p.occurrences(saturday, null, true);
        long start = System.nanoTime();
        for (int i = 0; i < 10000; i++) check(cached == p.occurrences(saturday + i, null, true), "Drawing reuses all 4096 projected events");
        double elapsed = (System.nanoTime() - start) / 1000000d;
        System.out.println("NativeCalendarProjection: " + checks + " assertions passed; 10,000 cached draws " + Math.round(elapsed) + " ms (local JVM, not TV timing).");
    }
}
