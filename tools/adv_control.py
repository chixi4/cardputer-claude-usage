#!/usr/bin/env python3
"""Small serial helper for Claude Usage Cardputer ADV diagnostics."""

from __future__ import annotations

import argparse
import sys
import time


def import_serial():
    try:
        import serial  # type: ignore
        from serial.tools import list_ports  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        raise SystemExit(f"pyserial is required: {exc}") from exc
    return serial, list_ports


def list_serial_ports():
    _serial, list_ports = import_serial()
    return list(list_ports.comports())


def choose_port(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    ports = list_serial_ports()
    if not ports:
        raise SystemExit("No serial ports found.")

    preferred = []
    for port in ports:
        text = f"{port.device} {port.description} {port.manufacturer}".lower()
        if "usbmodem" in text or "esp32" in text or "jtag" in text or "m5" in text:
            preferred.append(port)
    return (preferred or ports)[0].device


def print_ports() -> None:
    ports = list_serial_ports()
    if not ports:
        print("No serial ports found.")
        return
    for port in ports:
        print(f"{port.device}\t{port.description}\t{port.manufacturer or ''}")


def monitor(port: str, baud: int, duration: float) -> int:
    serial, _list_ports = import_serial()
    deadline = time.monotonic() + duration
    with serial.Serial(port, baudrate=baud, timeout=0.1) as ser:
        while time.monotonic() < deadline:
            try:
                data = ser.readline()
            except (OSError, serial.SerialException) as exc:
                print(f"[serial] disconnected: {exc}")
                return 2
            if data:
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                sys.stdout.flush()
    return 0


def send_command(port: str, baud: int, command: str, duration: float) -> int:
    serial, _list_ports = import_serial()
    with serial.Serial(port, baudrate=baud, timeout=0.1) as ser:
        time.sleep(0.2)
        ser.write((command.strip() + "\n").encode("utf-8"))
        ser.flush()
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            try:
                data = ser.readline()
            except (OSError, serial.SerialException) as exc:
                print(f"[serial] disconnected: {exc}")
                return 2
            if data:
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list serial ports")
    parser.add_argument("--port", help="serial port, for example /dev/cu.usbmodem1201")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--command", default="status", help="command to send: status, ble-reset, reboot, clear")
    parser.add_argument("--duration", type=float, default=3.0, help="seconds to capture after command")
    parser.add_argument("--monitor", action="store_true", help="only monitor serial output")
    args = parser.parse_args(argv)

    if args.list:
        print_ports()
        return 0

    port = choose_port(args.port)
    if args.monitor:
        return monitor(port, args.baud, args.duration)
    return send_command(port, args.baud, args.command, args.duration)


if __name__ == "__main__":
    raise SystemExit(main())
