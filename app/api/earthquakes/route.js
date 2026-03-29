import { NextResponse } from "next/server";

/**
 * GET /api/earthquakes
 *
 * Normalized response:
 * [
 *   { id, lat, lon, magnitude, place, time }
 * ]
 */
export async function GET() {
  const SOURCE_URL =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

  // Mock fallback keeps the frontend layer stable when upstream fails.
  const mockEarthquakes = [
    {
      id: "eq-mock-1",
      lat: 9.03,
      lon: 38.74,
      magnitude: 3.2,
      place: "Near Addis Ababa (mock)",
      time: Date.now() - 2 * 60 * 60 * 1000,
    },
    {
      id: "eq-mock-2",
      lat: 8.88,
      lon: 38.93,
      magnitude: 4.6,
      place: "Central Ethiopia (mock)",
      time: Date.now() - 5 * 60 * 60 * 1000,
    },
    {
      id: "eq-mock-3",
      lat: 8.71,
      lon: 38.52,
      magnitude: 5.3,
      place: "Rift Valley area (mock)",
      time: Date.now() - 9 * 60 * 60 * 1000,
    },
    {
      id: "eq-mock-4",
      lat: 9.21,
      lon: 38.49,
      magnitude: 2.8,
      place: "North of Addis region (mock)",
      time: Date.now() - 12 * 60 * 60 * 1000,
    },
  ];

  const withFallback = () => {
    console.log("[Earthquakes API] Using fallback mock dataset.");
    return mockEarthquakes;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "cesium-nextjs-earthquakes-proxy" },
    });

    if (!res.ok) return NextResponse.json(withFallback(), { status: 200 });

    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];

    const normalized = features
      .map((f) => {
        const id = String(f?.id ?? "");
        const coords = f?.geometry?.coordinates;
        const lon = Number(coords?.[0]);
        const lat = Number(coords?.[1]);
        const magnitude = Number(f?.properties?.mag);
        const place = typeof f?.properties?.place === "string" ? f.properties.place : "";
        const time = Number(f?.properties?.time);

        return { id, lat, lon, magnitude, place, time };
      })
      .filter(
        (e) =>
          e.id &&
          Number.isFinite(e.lat) &&
          Number.isFinite(e.lon) &&
          Number.isFinite(e.magnitude) &&
          Number.isFinite(e.time)
      );

    if (normalized.length === 0) return NextResponse.json(withFallback(), { status: 200 });

    console.log("[Earthquakes API] Using real data.");
    return NextResponse.json(normalized, { status: 200 });
  } catch {
    return NextResponse.json(withFallback(), { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}

