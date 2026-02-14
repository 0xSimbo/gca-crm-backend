#!/usr/bin/env python3
"""Solar farm calculator using NASA POWER hourly irradiance data."""

from __future__ import annotations

import argparse
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

import requests

NASA_POWER_HOURLY_URL = "https://power.larc.nasa.gov/api/temporal/hourly/point"

# Base rates + 3.85 cents fuel adjustment
FUEL_ADJ_CENTS = 3.85
RATE_SUMMER_ON_CENTS = 27.5 + FUEL_ADJ_CENTS  # 31.35
RATE_SUMMER_OFF_CENTS = 3.6 + FUEL_ADJ_CENTS  # 7.45
RATE_WINTER_BASE_CENTS = 6.9 + FUEL_ADJ_CENTS  # 10.75
RATE_WINTER_EXCESS_CENTS = 4.45 + FUEL_ADJ_CENTS  # 8.30

SUMMER_MONTHS = {6, 7, 8, 9, 10}
MONTH_NAMES = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Estimate monthly production/value buckets and blended $/kWh from "
            "NASA hourly irradiance data."
        )
    )
    parser.add_argument("latitude", nargs="?", type=float, help="Site latitude")
    parser.add_argument("longitude", nargs="?", type=float, help="Site longitude")
    parser.add_argument(
        "annual_kwh",
        nargs="?",
        type=float,
        help="Expected annual energy production in kWh",
    )
    parser.add_argument(
        "--year",
        type=int,
        default=2023,
        help="Calendar year to fetch from NASA POWER API (default: 2023)",
    )
    parser.add_argument(
        "--debug-dir",
        default="nasa_debug_output",
        help="Directory where monthly irradiance debug files are written",
    )

    args = parser.parse_args()

    provided = [args.latitude, args.longitude, args.annual_kwh]
    if any(value is not None for value in provided) and not all(
        value is not None for value in provided
    ):
        parser.error(
            "Provide all positional args (latitude longitude annual_kwh), "
            "or none to use interactive prompts."
        )

    current_year = date.today().year
    if args.year < 1981 or args.year > current_year:
        parser.error(f"--year must be between 1981 and {current_year}.")

    if args.annual_kwh is not None and args.annual_kwh <= 0:
        parser.error("annual_kwh must be greater than 0.")

    return args


def prompt_for_inputs() -> tuple[float, float, float]:
    try:
        print("--- Solar Farm Calculator (Battery Included) ---")
        latitude = float(input("Please enter the latitude: ").strip())
        longitude = float(input("Please enter the longitude: ").strip())
        annual_kwh = float(
            input("Please enter total annual farm production in kWh: ").strip()
        )
    except ValueError:
        print("Invalid input. Please enter numeric values.", file=sys.stderr)
        raise SystemExit(1)

    if annual_kwh <= 0:
        print("Annual kWh must be greater than 0.", file=sys.stderr)
        raise SystemExit(1)

    return latitude, longitude, annual_kwh


def fetch_hourly_nasa_data(latitude: float, longitude: float, year: int) -> dict[str, Any]:
    params = {
        "parameters": "ALLSKY_SFC_SW_DWN",
        "community": "RE",
        "longitude": longitude,
        "latitude": latitude,
        "start": f"{year}0101",
        "end": f"{year}1231",
        "format": "json",
    }

    print("Fetching hourly solar data from NASA POWER API...")
    try:
        response = requests.get(NASA_POWER_HOURLY_URL, params=params, timeout=60)
        response.raise_for_status()
    except requests.RequestException as exc:
        print(f"Error fetching data from NASA API: {exc}", file=sys.stderr)
        raise SystemExit(1)

    try:
        data = response.json()
    except ValueError:
        print("NASA API returned invalid JSON.", file=sys.stderr)
        raise SystemExit(1)

    return data


def write_debug_files(debug_matrix: dict[int, dict[int, list[float]]], output_dir: str) -> None:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    print(f"Writing debug files to folder: {output_path}/")

    for month in range(1, 13):
        month_days = debug_matrix.get(month)
        if not month_days:
            continue

        month_file = output_path / f"{MONTH_NAMES[month]}.txt"
        with month_file.open("w", encoding="utf-8") as handle:
            handle.write(
                f"Daily Solar Irradiance Profile for {MONTH_NAMES[month]} (Hour 00-23)\n"
            )
            handle.write(
                "Day | 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23\n"
            )
            handle.write("-" * 100 + "\n")
            for day in sorted(month_days):
                hours = " ".join(f"{value:4.2f}" for value in month_days[day])
                handle.write(f"{day:02d}  | {hours}\n")

    print("Debug files generated.\n")


def analyze_solar_data(data: dict[str, Any], annual_kwh: float, debug_dir: str) -> None:
    # NASA API 'ALLSKY_SFC_SW_DWN' is in Local Solar Time (LST).
    solar_data = (
        data.get("properties", {})
        .get("parameter", {})
        .get("ALLSKY_SFC_SW_DWN")
    )
    if not isinstance(solar_data, dict):
        print("Unexpected NASA API payload: missing ALLSKY_SFC_SW_DWN.", file=sys.stderr)
        raise SystemExit(1)

    valid_data_points: dict[str, float] = {}
    for timestamp, value in solar_data.items():
        try:
            irradiance = float(value)
        except (TypeError, ValueError):
            continue
        if irradiance == -999.0:
            continue
        valid_data_points[timestamp] = irradiance

    if not valid_data_points:
        print("No valid solar data points found for this location.", file=sys.stderr)
        raise SystemExit(1)

    total_irradiance_raw = sum(valid_data_points.values())
    if total_irradiance_raw <= 0:
        print("NASA irradiance sum is 0; cannot scale production.", file=sys.stderr)
        raise SystemExit(1)

    production_ratio = annual_kwh / total_irradiance_raw

    monthly_stats = {
        month: {
            "summer_on": 0.0,
            "summer_off": 0.0,
            "winter_total": 0.0,
            "winter_base": 0.0,
            "winter_excess": 0.0,
            "total_kwh": 0.0,
        }
        for month in range(1, 13)
    }
    debug_matrix: dict[int, dict[int, list[float]]] = {}

    for timestamp, irradiance in valid_data_points.items():
        try:
            dt = datetime.strptime(timestamp, "%Y%m%d%H")
        except ValueError:
            continue

        month = dt.month
        day = dt.day
        hour = dt.hour

        month_bucket = debug_matrix.setdefault(month, {})
        day_bucket = month_bucket.setdefault(day, [0.0] * 24)
        day_bucket[hour] = irradiance

        kwh_in_hour = irradiance * production_ratio
        stats = monthly_stats[month]
        stats["total_kwh"] += kwh_in_hour

        if month in SUMMER_MONTHS:
            if month == 10:
                stats["summer_off"] += kwh_in_hour
            else:
                stats["summer_on"] += kwh_in_hour
        else:
            stats["winter_total"] += kwh_in_hour

    write_debug_files(debug_matrix, debug_dir)

    grand_total_kwh = 0.0
    totals = {
        "summer_on": 0.0,
        "summer_off": 0.0,
        "winter_base": 0.0,
        "winter_excess": 0.0,
    }

    for month in range(1, 13):
        stats = monthly_stats[month]
        winter_total = stats["winter_total"]
        if winter_total > 0:
            stats["winter_base"] = min(winter_total, 600.0)
            stats["winter_excess"] = max(winter_total - 600.0, 0.0)

        grand_total_kwh += stats["total_kwh"]
        totals["summer_on"] += stats["summer_on"]
        totals["summer_off"] += stats["summer_off"]
        totals["winter_base"] += stats["winter_base"]
        totals["winter_excess"] += stats["winter_excess"]

    if grand_total_kwh <= 0:
        print("Calculated annual production is 0.", file=sys.stderr)
        raise SystemExit(1)

    header = (
        f"{'Month':<12} | {'% Annual':>10} | {'Total kWh':>10} | "
        f"{'Sum On-Pk':>12} | {'Sum Off-Pk':>12} | {'Win <600':>12} | {'Win >600':>12}"
    )
    print("-" * len(header))
    print(header)
    print("-" * len(header))

    for month in range(1, 13):
        stats = monthly_stats[month]
        pct = (stats["total_kwh"] / grand_total_kwh) * 100

        summer_on = f"{stats['summer_on']:.0f}" if stats["summer_on"] > 0 else ""
        summer_off = f"{stats['summer_off']:.0f}" if stats["summer_off"] > 0 else ""
        winter_base = f"{stats['winter_base']:.0f}" if stats["winter_base"] > 0 else ""
        winter_excess = (
            f"{stats['winter_excess']:.0f}" if stats["winter_excess"] > 0 else ""
        )

        print(
            f"{MONTH_NAMES[month]:<12} | {pct:>9.2f}% | {stats['total_kwh']:>10.0f} | "
            f"{summer_on:>12} | {summer_off:>12} | {winter_base:>12} | {winter_excess:>12}"
        )

    print("-" * len(header))
    print(
        f"{'TOTAL':<12} | {'100.00%':>10} | {grand_total_kwh:>10.0f} | "
        f"{totals['summer_on']:>12.0f} | {totals['summer_off']:>12.0f} | "
        f"{totals['winter_base']:>12.0f} | {totals['winter_excess']:>12.0f}"
    )
    print("=" * len(header))
    print()

    cost_summer_on = totals["summer_on"] * RATE_SUMMER_ON_CENTS / 100.0
    cost_summer_off = totals["summer_off"] * RATE_SUMMER_OFF_CENTS / 100.0
    cost_winter_base = totals["winter_base"] * RATE_WINTER_BASE_CENTS / 100.0
    cost_winter_excess = totals["winter_excess"] * RATE_WINTER_EXCESS_CENTS / 100.0
    total_cost = cost_summer_on + cost_summer_off + cost_winter_base + cost_winter_excess
    price_per_kwh = total_cost / grand_total_kwh

    print("Costs Breakdown (With Battery System):")
    print(f"  Summer On-peak       ({RATE_SUMMER_ON_CENTS:.2f}c): ${cost_summer_on:,.2f}")
    print(f"  Summer Off-peak      ({RATE_SUMMER_OFF_CENTS:.2f}c): ${cost_summer_off:,.2f}")
    print(f"  Winter first 600 kWh ({RATE_WINTER_BASE_CENTS:.2f}c): ${cost_winter_base:,.2f}")
    print(
        f"  Winter over 600 kWh  ({RATE_WINTER_EXCESS_CENTS:.2f}c): "
        f"${cost_winter_excess:,.2f}"
    )
    print("-" * 35)
    print(f"TOTAL VALUE:            ${total_cost:,.2f}")
    print("-" * 35)
    print(f"$/kWh:                  ${price_per_kwh:.4f}")


def main() -> None:
    args = parse_args()
    if args.latitude is None:
        latitude, longitude, annual_kwh = prompt_for_inputs()
    else:
        latitude = args.latitude
        longitude = args.longitude
        annual_kwh = args.annual_kwh

    assert annual_kwh is not None
    data = fetch_hourly_nasa_data(latitude, longitude, args.year)
    analyze_solar_data(data, annual_kwh, args.debug_dir)


if __name__ == "__main__":
    main()
