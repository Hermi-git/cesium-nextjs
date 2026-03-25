import { NextResponse } from "next/server";

/**
 * GET /api/satellites
 *
 * Proxies wheretheiss.at satellite tracking and returns a normalized JSON array.
 *
 * Response format:
 * [
 *   { id, lat, lon, altitude, velocity, name }
 * ]
 *
 * Notes:
 * - `altitude` is returned in meters (Cesium expects meters for fromDegrees).
 * - `velocity` is returned in km/h (matches wheretheiss.at units).
 * - If the external API fails, we return small mock data (1–3 satellites) so
 *   the frontend never renders an empty layer.
 */
export async function GET() {
  const SOURCE_URL = "https://api.wheretheiss.at/v1/satellites/25544";

  const ADDIS_ABABA = { lat: 8.9806, lon: 38.7578 };

  // Small deterministic mock set around Addis Ababa.
  const mockSatellites = [
    {
      id: "25544",
      name: "ISS (mock)",
      lat: ADDIS_ABABA.lat + 0.02,
      lon: ADDIS_ABABA.lon - 0.03,
      altitude: 420000,
      velocity: 27500,
    },
    {
      id: "25544-B",
      name: "ISS Alt (mock)",
      lat: ADDIS_ABABA.lat - 0.015,
      lon: ADDIS_ABABA.lon + 0.02,
      altitude: 415000,
      velocity: 26000,
    },
  ];

  const withFallback = () => {
    console.log("[Satellites API] Using fallback mock dataset.");
    return mockSatellites;
  };

  const controller = new AbortController();
  const timeoutMs = 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "cesium-nextjs-satellites-proxy" },
    });

    if (!res.ok) return NextResponse.json(withFallback(), { status: 200 });

    const data = await res.json();

    const lat = Number(data?.latitude);
    const lon = Number(data?.longitude);
    const altitudeKm = Number(data?.altitude); // wheretheiss.at returns km
    const velocityKmh = Number(data?.velocity);
    const id = String(data?.id ?? "unknown");
    const name = typeof data?.name === "string" ? data.name : "";

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(altitudeKm) ||
      !Number.isFinite(velocityKmh)
    ) {
      return NextResponse.json(withFallback(), { status: 200 });
    }

    console.log("[Satellites API] Using real data.");
    return NextResponse.json(
      [
        {
          id,
          lat,
          lon,
          altitude: altitudeKm * 1000, // meters
          velocity: velocityKmh, // km/h
          name,
        },
      ],
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json(withFallback(), { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}

