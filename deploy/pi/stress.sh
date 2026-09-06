#!/usr/bin/env bash
#
# Asks the Pi whether its power supply holds up under load. Runs *on the Pi*.
#
#   deploy/pi/stress.sh            # 10 Minuten
#   deploy/pi/stress.sh 20         # 20 Minuten
#
# Why this and not a wattmeter: a Raspberry Pi 4 cannot report how much current it is drawing.
# What it can report is the firmware's own verdict — a comparator that trips when the 5 V rail
# sags below ~4.63 V, latched since boot so a dip lasting a millisecond at 3 a.m. is still
# visible in the morning. That latched bit is the only honest answer to "is the charger enough",
# and it only means something after the board has actually been made to draw current.
#
# So: all four cores, memory, and the SD card at once, for long enough that the supply is warm
# and any voltage droop has had its chance.

set -uo pipefail

MINUTES="${1:-10}"
SECONDS_TOTAL=$(( MINUTES * 60 ))
LOG="${PMS_STRESS_LOG:-/tmp/pms-stress.log}"
# Muss auf echtem Speicher liegen, nicht im tmpfs — sonst belastet die Schreiblast den RAM.
SCRATCH="${PMS_STRESS_SCRATCH:-$HOME/.pms-stress.bin}"

if ! command -v vcgencmd >/dev/null 2>&1; then
    echo "vcgencmd fehlt — dieses Skript gehört auf einen Raspberry Pi." >&2
    exit 1
fi

# ---------------------------------------------------------------- bit decoding
#
# From the firmware's documented layout. Bits 0-3 are "right now", bits 16-19 are "has happened
# since boot" and never clear on their own. The second group is the one that matters: a Pi that
# is fine at the moment it is asked can still have browned out under load an hour ago.

describe() {
    local v=$(( $1 ))
    local out=""
    (( v & 0x1 ))     && out="$out; Unterspannung JETZT"
    (( v & 0x2 ))     && out="$out; Takt gedrosselt JETZT"
    (( v & 0x4 ))     && out="$out; gedrosselt JETZT"
    (( v & 0x8 ))     && out="$out; Temperaturgrenze JETZT"
    (( v & 0x10000 )) && out="$out; Unterspannung SEIT START"
    (( v & 0x20000 )) && out="$out; Taktdeckelung SEIT START"
    (( v & 0x40000 )) && out="$out; Drosselung SEIT START"
    (( v & 0x80000 )) && out="$out; Temperaturgrenze SEIT START"
    [ -z "$out" ] && out="; sauber"
    echo "${out#; }"
}

START_STATE="$(vcgencmd get_throttled | cut -d= -f2)"
echo "Zustand vor dem Test: $START_STATE ($(describe "$START_STATE"))"
if (( START_STATE & 0x10000 )); then
    echo
    echo "  ACHTUNG: die Unterspannungs-Markierung steht schon vor dem Test."
    echo "  Sie wird nur durch einen Neustart gelöscht — für ein sauberes Ergebnis"
    echo "  erst neu starten, dann dieses Skript laufen lassen."
fi

# ---------------------------------------------------------------- the load

echo
echo "Last für $MINUTES Minuten: 4 CPU-Kerne, 2 Speicher-Worker, SD-Karten-Schreiblast."
echo "Mitschrift: $LOG"
echo

: > "$LOG"

if command -v stress-ng >/dev/null 2>&1; then
    stress-ng --cpu 4 --cpu-method matrixprod \
              --vm 2 --vm-bytes 512M \
              --hdd 1 --hdd-bytes 256M \
              --timeout "${SECONDS_TOTAL}s" --metrics-brief \
              > "$LOG.stress" 2>&1 &
else
    # Notlast ohne stress-ng, damit der Test auch auf einem noch nicht eingerichteten Gerät
    # läuft. Absichtlich lückenlos: ein Lastprofil mit Pausen misst nichts, weil die Spannung
    # sich in jeder Pause erholt und der Komparator nie auslöst.
    echo "(stress-ng fehlt — Notlast aus Bordmitteln)"
    # Zwei Kerne auf der Krypto-Einheit, zwei auf Integer und Speicher. Zusammen vier Kerne
    # ohne Leerlauf.
    sha256sum /dev/zero & sha256sum /dev/zero &
    gzip -9 -c /dev/urandom > /dev/null & gzip -9 -c /dev/urandom > /dev/null &
    # Die SD-Karte, weil ihr Schreibstrom auf derselben 5-V-Schiene liegt.
    # Nicht nach /tmp: das ist auf Raspberry Pi OS ein tmpfs, und dann misst der Test RAM.
    ( while :; do
          dd if=/dev/zero of="$SCRATCH" bs=1M count=256 conv=fsync 2>/dev/null
      done ) &
fi

LOAD_PIDS="$(jobs -p)"
stop_load() {
    # Erst die Kinder dieser Shell, dann deren eigene Kinder: `kill` auf eine Subshell lässt
    # das dd darin weiterlaufen, und eine Schreiblast, die den Test überlebt, frisst still
    # weiter an der SD-Karte.
    kill $LOAD_PIDS 2>/dev/null
    pkill -P $$ 2>/dev/null
    rm -f "$SCRATCH"
}
trap stop_load EXIT INT TERM

WORST=0
PEAK_TEMP=0
MIN_CLOCK=99999999

END=$(( $(date +%s) + SECONDS_TOTAL ))
while [ "$(date +%s)" -lt "$END" ]; do
    T="$(vcgencmd get_throttled | cut -d= -f2)"
    TEMP="$(vcgencmd measure_temp | cut -d= -f2 | tr -d "'C")"
    CLOCK=$(( $(vcgencmd measure_clock arm | cut -d= -f2) / 1000000 ))
    VOLT="$(vcgencmd measure_volts core | cut -d= -f2)"
    printf '%s throttled=%s temp=%s clock=%sMHz core=%s load=%s\n' \
        "$(date +%H:%M:%S)" "$T" "$TEMP" "$CLOCK" "$VOLT" "$(cut -d' ' -f1 /proc/loadavg)" \
        | tee -a "$LOG"
    WORST=$(( WORST | T ))
    awk -v a="$TEMP" -v b="$PEAK_TEMP" 'BEGIN{exit !(a>b)}' && PEAK_TEMP="$TEMP"
    [ "$CLOCK" -lt "$MIN_CLOCK" ] && MIN_CLOCK="$CLOCK"
    sleep 5
done

stop_load
wait 2>/dev/null

# ---------------------------------------------------------------- verdict

echo
echo "===================== Ergebnis ====================="
printf 'Schlechtester Zustand : 0x%x (%s)\n' "$WORST" "$(describe "$WORST")"
echo   "Höchste Temperatur    : ${PEAK_TEMP}°C"
echo   "Niedrigster Takt      : ${MIN_CLOCK} MHz (normal 1500, gedrosselt 600)"
echo
if (( WORST & 0x10001 )); then
    echo "✗ NETZTEIL REICHT NICHT."
    echo "  Die Spannung ist unter Last eingebrochen. Ein Pi 4 braucht 5 V / 3 A (15 W) an"
    echo "  einem Kabel, das das auch trägt — sehr oft ist das Kabel und nicht das Netzteil"
    echo "  schuld. Unterspannung beschädigt auf Dauer die SD-Karte, und ein Datenbank-"
    echo "  schreibvorgang, der mitten im Einbruch abbricht, ist genau der Weg zu einer"
    echo "  kaputten mailbox.db."
elif (( WORST & 0x8008 )); then
    echo "△ Netzteil in Ordnung, aber die Temperaturgrenze wurde erreicht."
    echo "  Das ist Kühlung, nicht Strom. Ein Gehäuse mit Kühlkörper genügt."
elif (( WORST & 0x40004 )); then
    echo "△ Gedrosselt, ohne Unterspannung — also Temperatur. Siehe oben."
else
    echo "✓ Netzteil und Kühlung halten $MINUTES Minuten Volllast aus."
    echo "  Das ist mehr, als dieser Dienst je verlangt: der Sync ist überwiegend Warten"
    echo "  auf Proton, mit ~900 ms Pause zwischen zwei Anfragen."
fi
echo "===================================================="
[ -f "$LOG.stress" ] && { echo; echo "stress-ng:"; tail -12 "$LOG.stress"; }
