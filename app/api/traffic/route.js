import { NextResponse } from "next/server";

/**
 * GET /api/traffic
 *
 * Fetches Addis Ababa road geometries from Overpass (OpenStreetMap)
 * and returns normalized road paths:
 * [
 *   { id: string, path: [[lon, lat], [lon, lat], ...] }
 * ]
 */
export async function GET() {
  // Bounding box around Addis Ababa: (south, west, north, east)
  const bbox = { s: 8.84, w: 38.63, n: 9.10, e: 38.90 };

  // Limit payload size with a shorter timeout and only way geometries.
  const overpassQuery = `
[out:json][timeout:20];
way["highway"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});
out geom;
`;

  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  const MAX_ROADS = 40;

  const mockRoads = [
    {
      id: "mock-road-1",
      path: [
        [38.737, 8.995],
        [38.744, 8.988],
        [38.752, 8.981],
        [38.761, 8.974],
      ],
    },
    {
      id: "mock-road-2",
      path: [
        [38.706, 8.968],
        [38.718, 8.972],
        [38.731, 8.976],
        [38.745, 8.982],
      ],
    },
    {
      id: "mock-road-3",
      path: [
        [38.781, 8.946],
        [38.773, 8.956],
        [38.766, 8.966],
        [38.758, 8.978],
      ],
    },
    {
      id: "mock-road-4",
      path: [
        [38.686, 8.932],
        [38.698, 8.941],
        [38.712, 8.950],
        [38.727, 8.960],
      ],
    },
    {
      id: "mock-road-5",
      path: [
        [38.799, 8.999],
        [38.786, 8.992],
        [38.771, 8.986],
        [38.757, 8.981],
      ],
    },
  ];

  const withFallback = () => {
    console.log("[Traffic API] Using fallback mock roads.");
    return mockRoads;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "cesium-nextjs-traffic-proxy",
      },
      body: `data=${encodeURIComponent(overpassQuery)}`,
    });

    if (!res.ok) return NextResponse.json(withFallback(), { status: 200 });

    const data = await res.json();
    const elements = Array.isArray(data?.elements) ? data.elements : [];

    const roads = [];
    for (const el of elements) {
      if (el?.type !== "way") continue;
      if (!Array.isArray(el?.geometry)) continue;

      const path = el.geometry
        .map((g) => [Number(g?.lon), Number(g?.lat)])
        .filter(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            Number.isFinite(p[0]) &&
            Number.isFinite(p[1])
        );

      if (path.length < 2) continue;

      roads.push({
        id: String(el.id),
        path,
      });

      if (roads.length >= MAX_ROADS) break;
    }

    if (roads.length === 0) return NextResponse.json(withFallback(), { status: 200 });

    console.log(`[Traffic API] Using real OSM roads (${roads.length}).`);
    return NextResponse.json(roads, { status: 200 });
  } catch {
    return NextResponse.json(withFallback(), { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}

