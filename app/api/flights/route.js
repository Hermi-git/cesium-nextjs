import { NextResponse } from "next/server";

/**
 * GET /api/flights
 *
 * Fetches flight state data from OpenSky Network and returns a minimal,
 * clean JSON array suitable for rendering on Cesium.
 *
 * Output:
 * [
 *   { "id": "flight1", "lat": number, "lon": number, "altitude": number }
 * ]
 */
export async function GET() {
  const OPEN_SKY_URL = "https://opensky-network.org/api/states/all";

  const ADDIS_ABABA = { lat: 8.9806, lon: 38.7578 };

  // Deterministic fallback dataset so the map never looks empty.
  // Coordinates are jittered around Addis Ababa.
  const mockFlights = [
    { id: "F-001", lat: 8.923, lon: 38.703, altitude: 4200 },
    { id: "F-002", lat: 8.942, lon: 38.712, altitude: 6100 },
    { id: "F-003", lat: 8.959, lon: 38.721, altitude: 7800 },
    { id: "F-004", lat: 8.968, lon: 38.732, altitude: 5200 },
    { id: "F-005", lat: 8.931, lon: 38.747, altitude: 6900 },
    { id: "F-006", lat: 8.897, lon: 38.761, altitude: 8600 },
    { id: "F-007", lat: 8.908, lon: 38.774, altitude: 4300 },
    { id: "F-008", lat: 8.979, lon: 38.681, altitude: 10100 },
    { id: "F-009", lat: 8.989, lon: 38.698, altitude: 7400 },
    { id: "F-010", lat: 8.915, lon: 38.710, altitude: 5300 },
    { id: "F-011", lat: 8.905, lon: 38.742, altitude: 9600 },
    { id: "F-012", lat: 8.972, lon: 38.751, altitude: 6500 },
    { id: "F-013", lat: 8.884, lon: 38.729, altitude: 8800 },
    { id: "F-014", lat: 8.937, lon: 38.785, altitude: 5900 },
    { id: "F-015", lat: 8.951, lon: 38.794, altitude: 11200 },
    { id: "F-016", lat: 8.961, lon: 38.806, altitude: 7600 },
    { id: "F-017", lat: 8.890, lon: 38.742, altitude: 4100 },
    { id: "F-018", lat: 8.905, lon: 38.773, altitude: 7300 },
    { id: "F-019", lat: 8.922, lon: 38.790, altitude: 6800 },
    { id: "F-020", lat: 8.976, lon: 38.699, altitude: 5200 },
    { id: "F-021", lat: 8.986, lon: 38.720, altitude: 9400 },
    { id: "F-022", lat: 8.959, lon: 38.812, altitude: 6200 },
    { id: "F-023", lat: 8.899, lon: 38.803, altitude: 8700 },
    { id: "F-024", lat: 8.934, lon: 38.668, altitude: 7800 },
    { id: "F-025", lat: 9.004, lon: 38.737, altitude: 10400 },
  ];

  const withFallback = () => {
    console.log("[Flights API] Using fallback mock dataset (OpenSky failed/empty).");

    // Keep the exact format expected by the frontend:
    // { id, lat, lon, altitude }
    // (Optional: ensure lat/lon aren’t null, and keep around Addis.)
    return mockFlights.map((f) => ({
      id: f.id,
      lat: Number(f.lat) || ADDIS_ABABA.lat,
      lon: Number(f.lon) || ADDIS_ABABA.lon,
      altitude: Number(f.altitude) || 5000,
    }));
  };

  // Keep requests bounded so the UI stays responsive.
  const controller = new AbortController();
  const timeoutMs = 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPEN_SKY_URL, {
      signal: controller.signal,
      // Some providers are happier with a UA header from server environments.
      headers: { "User-Agent": "cesium-nextjs-flight-layer" },
    });

    if (!res.ok) {
      // OpenSky failed (non-2xx). Fall back to mock data so the frontend never looks empty.
      return NextResponse.json(withFallback(), { status: 200 });
    }

    const data = await res.json();
    const states = Array.isArray(data?.states) ? data.states : [];

    const flights = [];

    for (const s of states) {
      // OpenSky "states/all" format:
      // [0] icao24
      // [1] callsign
      // [5] longitude
      // [6] latitude
      // [7] baroAltitude
      const icao24 = s?.[0];
      const callsignRaw = s?.[1];
      const lon = s?.[5];
      const lat = s?.[6];
      const altitudeRaw = s?.[7];

      // Filter invalid null lat/lon (and non-finite values).
      if (lat == null || lon == null) continue;
      const latNum = Number(lat);
      const lonNum = Number(lon);
      if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) continue;

      // Keep altitude as a number (skip if null/invalid).
      if (altitudeRaw == null) continue;
      const altitudeNum = Number(altitudeRaw);
      if (!Number.isFinite(altitudeNum)) continue;

      const callsign = typeof callsignRaw === "string" ? callsignRaw.trim() : "";
      const id = callsign || (typeof icao24 === "string" ? icao24 : "unknown");

      flights.push({
        id,
        lat: latNum,
        lon: lonNum,
        altitude: altitudeNum,
      });
    }

    // If OpenSky returned no usable positions, use fallback.
    if (flights.length === 0) {
      return NextResponse.json(withFallback(), { status: 200 });
    }

    return NextResponse.json(flights, { status: 200 });
  } catch (err) {
    // Graceful failure: return fallback mock dataset.
    // If we timed out, treat it as a non-fatal poll failure.
    if (err?.name === "AbortError") {
      return NextResponse.json(withFallback(), { status: 200 });
    }
    console.error("[Flights API] Failed to fetch/parse OpenSky data:", err);
    return NextResponse.json(withFallback(), { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}

