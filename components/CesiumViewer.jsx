'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen Cesium Viewer for Next.js App Router.
 *
 * Setup notes:
 * 1) Cesium runtime files (Workers/Assets/Widgets/ThirdParty) are copied to `public/cesium`
 *    via `scripts/copy-cesium-assets.js` (hooked up in `package.json` as `postinstall`).
 * 2) We set `globalThis.CESIUM_BASE_URL = '/cesium/'` so Cesium can load those files at runtime.
 * 3) Cesium Ion world terrain requires `NEXT_PUBLIC_CESIUM_ION_TOKEN`.
 */
export default function CesiumViewer({ ionToken }) {
  const containerRef = useRef(null);
  const [showFlights, setShowFlights] = useState(true);
  const [flightDetails, setFlightDetails] = useState(null);
  const [showSatellites, setShowSatellites] = useState(true);
  const [satelliteDetails, setSatelliteDetails] = useState(null);
  const [showEarthquakes, setShowEarthquakes] = useState(true);
  const [earthquakeDetails, setEarthquakeDetails] = useState(null);
  const [showTraffic, setShowTraffic] = useState(true);
  const [trafficDetails, setTrafficDetails] = useState(null);
  const [showDebug, setShowDebug] = useState(false);

  // Lightweight debug stats (updated ~every 500ms, not per-frame).
  const flightsCountRef = useRef(0);
  const satellitesCountRef = useRef(0);
  const earthquakesCountRef = useRef(0);
  const trafficCarsCountRef = useRef(0);
  const fpsRef = useRef(0);
  const fpsCalcRef = useRef({ lastSampleMs: 0, frames: 0, fps: 0 });

  const showDebugRef = useRef(showDebug);
  useEffect(() => {
    showDebugRef.current = showDebug;
  }, [showDebug]);

  const [debugStats, setDebugStats] = useState({
    fps: 0,
    flights: 0,
    satellites: 0,
    earthquakes: 0,
    trafficCars: 0,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      if (!showDebugRef.current) return;
      setDebugStats({
        fps: fpsRef.current,
        flights: flightsCountRef.current,
        satellites: satellitesCountRef.current,
        earthquakes: earthquakesCountRef.current,
        trafficCars: trafficCarsCountRef.current,
      });
    }, 500);

    return () => clearInterval(interval);
  }, []);
  // Future layers can follow the same pattern:
  // - const [showWeather, setShowWeather] = useState(true);

  // Keep the latest checkbox state available inside Cesium polling closures.
  const showFlightsRef = useRef(showFlights);
  useEffect(() => {
    showFlightsRef.current = showFlights;
  }, [showFlights]);

  // Lets the UI toggle clear/resume flight entities without reinitializing Cesium.
  const clearFlightsRef = useRef(null);
  const syncFlightsRef = useRef(null);

  useEffect(() => {
    if (!showFlights) {
      clearFlightsRef.current?.();
      setFlightDetails(null);
      return;
    }

    // If toggled back on, sync immediately so the UI updates right away.
    syncFlightsRef.current?.();
  }, [showFlights]);

  // Satellite visibility toggle (independent from flights).
  const showSatellitesRef = useRef(showSatellites);
  useEffect(() => {
    showSatellitesRef.current = showSatellites;
  }, [showSatellites]);

  const setSatellitesVisibilityRef = useRef(null);
  useEffect(() => {
    setSatelliteDetails(null);
    setSatellitesVisibilityRef.current?.(showSatellites);
  }, [showSatellites]);

  // Earthquake visibility toggle (static points layer).
  const showEarthquakesRef = useRef(showEarthquakes);
  useEffect(() => {
    showEarthquakesRef.current = showEarthquakes;
  }, [showEarthquakes]);

  const setEarthquakesVisibilityRef = useRef(null);
  useEffect(() => {
    setEarthquakeDetails(null);
    setEarthquakesVisibilityRef.current?.(showEarthquakes);
  }, [showEarthquakes]);

  // Traffic visibility toggle (simulated cars on OSM roads).
  const showTrafficRef = useRef(showTraffic);
  useEffect(() => {
    showTrafficRef.current = showTraffic;
  }, [showTraffic]);

  const setTrafficVisibilityRef = useRef(null);
  useEffect(() => {
    setTrafficVisibilityRef.current?.(showTraffic);
    setTrafficDetails(null);
  }, [showTraffic]);

  useEffect(() => {
    if (!containerRef.current) return;

    let viewer = null;
    let cancelled = false;
    let intervalId = null;
    let animationFrameId = null;
    let satelliteIntervalId = null;
    let earthquakeIntervalId = null;
    let trafficIntervalId = null;
    let flightClickHandler = null;

    const init = async () => {
      console.log("[Cesium] Initializing viewer...");

      // Must match the directory we copy Cesium into: public/cesium
      // Cesium typically reads this from the browser global.
      globalThis.CESIUM_BASE_URL = "/cesium/";
      if (typeof window !== "undefined") {
        window.CESIUM_BASE_URL = "/cesium/";
      }

      const Cesium = await import("cesium");

      // Ion token is required for Cesium's default world terrain.
      if (!ionToken) {
        throw new Error(
          "Missing NEXT_PUBLIC_CESIUM_ION_TOKEN. Create `cesium-nextjs/.env.local` with your Cesium Ion token."
        );
      }
      Cesium.Ion.defaultAccessToken = ionToken;

      let terrainProvider;
      try {
        terrainProvider = Cesium.createWorldTerrainAsync
          ? await Cesium.createWorldTerrainAsync()
          : Cesium.createWorldTerrain();
      } catch (e) {
        console.error("[Cesium] Failed to create world terrain:", e);
        throw e;
      }

      if (cancelled) return;
      console.log("[Cesium] World terrain ready");

      viewer = new Cesium.Viewer(containerRef.current, {
        terrainProvider,

        // Keep the UI clean for a production-style globe.
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
      });

      // Center the camera on Addis Ababa.
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(38.7578, 8.9806, 5000),
        orientation: {
          heading: Cesium.Math.toRadians(0.0),
          pitch: Cesium.Math.toRadians(-35.0),
          roll: 0.0,
        },
      });

      // Improves appearance when combining terrain + 3D primitives.
      viewer.scene.globe.depthTestAgainstTerrain = true;

      // Performance-focused defaults (can be revisited per use-case).
      viewer.scene.fog.enabled = false;
      viewer.scene.globe.enableLighting = false;
      if (viewer.scene.postProcessStages?.fxaa) {
        viewer.scene.postProcessStages.fxaa.enabled = false;
      }
      console.log("[Cesium] Viewer created and camera set");

      // Add OpenStreetMap 3D buildings.
      // Cesium's helper is async in recent versions.
      try {
        const osmBuildings = Cesium.createOsmBuildingsAsync
          ? await Cesium.createOsmBuildingsAsync()
          : Cesium.createOsmBuildings();
        viewer.scene.primitives.add(osmBuildings);
      } catch (e) {
        console.error("[Cesium] Failed to create OSM 3D buildings:", e);
        throw e;
      }
      console.log("[Cesium] OSM 3D buildings added");

      // ------------------------------------------------------------
      // Flight layer: poll /api/flights and render airplane billboards + labels.
      // ------------------------------------------------------------
      // Airplane icon (white) encoded as an inline SVG data URL.
      // This keeps the change self-contained (no extra public assets).
      const AIRPLANE_ICON_URL =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <path fill="white" d="M61.7 26.3 5.9 2.5C4.4 1.9 2.8 2.7 2.2 4.2c-.5 1.2-.2 2.5.8 3.4l16.3 14.9-5.8 2.5c-.9.4-1.5 1.3-1.5 2.3s.6 1.9 1.5 2.3l5.8 2.5L3 47.2c-1 .9-1.3 2.2-.8 3.4.6 1.5 2.2 2.3 3.7 1.7l55.8-23.8c1-.4 1.7-1.4 1.7-2.5s-.7-2.1-1.7-2.5z"/>
          </svg>
        `);

      // Keep entities persistent so we can animate smoothly between poll updates.
      // Keyed by flight.id returned from the backend.
      const flightEntitiesById = new Map();

      // Per-flight motion state used for interpolation.
      // { fromPos, toPos, fromAlt, toAlt, t0, t1, headingRad }
      const flightMotionById = new Map();

      // Extra metadata (used for speed + click details).
      const flightMetaById = new Map();

      const clearFlightEntities = () => {
        for (const entity of flightEntitiesById.values()) {
          try {
            viewer.entities.remove(entity);
          } catch {
            // Best-effort removal.
          }
        }
        flightEntitiesById.clear();
        flightMotionById.clear();
        flightMetaById.clear();
        flightsCountRef.current = 0;
      };
      clearFlightsRef.current = clearFlightEntities;

      const fetchFlights = async () => {
        const res = await fetch("/api/flights", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Flights API failed with status ${res.status}`);
        }
        return res.json();
      };

      // Utility: bearing from (lat1, lon1) to (lat2, lon2) in radians.
      // Used to rotate the airplane icon to face direction of motion.
      const bearingRad = (lat1Deg, lon1Deg, lat2Deg, lon2Deg) => {
        const φ1 = Cesium.Math.toRadians(lat1Deg);
        const φ2 = Cesium.Math.toRadians(lat2Deg);
        const Δλ = Cesium.Math.toRadians(lon2Deg - lon1Deg);

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x =
          Math.cos(φ1) * Math.sin(φ2) -
          Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        return Math.atan2(y, x); // radians
      };

      const iconSizePx = 28;

      const altitudeToScale = (altMeters) =>
        Math.max(0.7, Math.min(1.1, 1.05 - altMeters / 60000));

      const refreshIntervalMs = 10000;

      // Animation internals are called by a single global loop (animateAll).
      const animateFlightsInternal = (nowPerf) => {
        if (!showFlightsRef.current) return;
        for (const [id, motion] of flightMotionById.entries()) {
          const entity = flightEntitiesById.get(id);
          if (!entity) continue;

          const denom = motion.t1 - motion.t0;
          const u = denom > 0 ? (nowPerf - motion.t0) / denom : 1;
          const t = Cesium.Math.clamp(u, 0, 1);

          // Smooth position.
          Cesium.Cartesian3.lerp(
            motion.fromPos,
            motion.toPos,
            t,
            motion.scratchPos
          );
          entity.position = motion.scratchPos;

          // Scale icon with altitude for a more "aircraft-like" feel.
          const altNow =
            motion.fromAlt + (motion.toAlt - motion.fromAlt) * t;
          entity.billboard.scale = altitudeToScale(altNow);

          // Rotate to face direction of motion (heading computed at poll time).
          entity.billboard.rotation = motion.headingRad ?? 0;
        }
      };

      const syncFlights = async () => {
        if (cancelled || !viewer) return;
        if (!showFlightsRef.current) return;

        try {
          const flightsRaw = await fetchFlights();
          if (cancelled || !viewer) return;

          // Cap entity count for performance.
          const flights = Array.isArray(flightsRaw) ? flightsRaw.slice(0, 100) : [];

          const incomingIds = new Set(flights.map((f) => f.id));

          // Remove flights that disappeared from the feed.
          for (const [id, entity] of flightEntitiesById.entries()) {
            if (!incomingIds.has(id)) {
              try {
                viewer.entities.remove(entity);
              } catch {
                // ignore
              }
              flightEntitiesById.delete(id);
              flightMotionById.delete(id);
              flightMetaById.delete(id);
            }
          }

          const nowPerf = performance.now();

          // Update/create entities and motion targets.
          for (const flight of flights) {
            const id = flight.id;

            const toPos = Cesium.Cartesian3.fromDegrees(
              flight.lon,
              flight.lat,
              flight.altitude
            );

            const toAlt = flight.altitude;

            const toScale = altitudeToScale(toAlt);

            const existingEntity = flightEntitiesById.get(id);
            const existingMotion = flightMotionById.get(id);
            const prevMeta = flightMetaById.get(id);

            if (!existingEntity) {
              const entity = viewer.entities.add({
                id,
                position: toPos,
                billboard: {
                  image: AIRPLANE_ICON_URL,
                  width: iconSizePx,
                  height: iconSizePx,
                  scale: toScale,
                  color: Cesium.Color.WHITE,
                  heightReference: Cesium.HeightReference.NONE,
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                  disableDepthTestDistance: 5000,
                  rotation: 0,
                },
                label: {
                  text: id,
                  font: "11px sans-serif",
                  fillColor: Cesium.Color.YELLOW,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 2,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new Cesium.Cartesian2(0, iconSizePx * 0.75),
                },
              });

              flightEntitiesById.set(id, entity);

              // No previous sample: start=end for interpolation.
              flightMotionById.set(id, {
                fromPos: toPos,
                toPos,
                fromAlt: toAlt,
                toAlt,
                t0: nowPerf,
                t1: nowPerf + refreshIntervalMs,
                headingRad: 0,
                scratchPos: new Cesium.Cartesian3(),
              });

              flightMetaById.set(id, {
                lastTimePerf: nowPerf,
                lastLon: flight.lon,
                lastLat: flight.lat,
                lastAlt: toAlt,
                lastPos: toPos,
                speedMps: 0,
              });

              continue;
            }

            // Interpolate smoothly from the current position at poll time.
            let fromPos = toPos;
            let fromAlt = toAlt;
            if (existingMotion) {
              const denom = existingMotion.t1 - existingMotion.t0;
              const u = denom > 0 ? (nowPerf - existingMotion.t0) / denom : 1;
              const t = Cesium.Math.clamp(u, 0, 1);
              const fromPosLerp = new Cesium.Cartesian3();
              Cesium.Cartesian3.lerp(
                existingMotion.fromPos,
                existingMotion.toPos,
                t,
                fromPosLerp
              );
              fromPos = fromPosLerp;
              fromAlt =
                existingMotion.fromAlt +
                (existingMotion.toAlt - existingMotion.fromAlt) * t;
            }

            // Estimate heading + speed using previous sample (if we have it).
            let heading = 0;
            let speedMps = prevMeta?.speedMps ?? 0;
            if (prevMeta) {
              heading = bearingRad(prevMeta.lastLat, prevMeta.lastLon, flight.lat, flight.lon);

              const dtSec = (nowPerf - prevMeta.lastTimePerf) / 1000;
              if (dtSec > 0.001) {
                const distMeters = Cesium.Cartesian3.distance(prevMeta.lastPos, toPos);
                speedMps = distMeters / dtSec;
              }
            }

            const scratchPos =
              existingMotion?.scratchPos ?? new Cesium.Cartesian3();

            // Update motion target for smooth interpolation.
            flightMotionById.set(id, {
              fromPos,
              toPos,
              fromAlt,
              toAlt,
              t0: nowPerf,
              t1: nowPerf + refreshIntervalMs,
              headingRad: heading,
              scratchPos,
            });

            // Update meta for next poll + click details.
            flightMetaById.set(id, {
              lastTimePerf: nowPerf,
              lastLon: flight.lon,
              lastLat: flight.lat,
              lastAlt: toAlt,
              lastPos: toPos,
              speedMps,
            });

            // Update label text if backend changes id text.
            existingEntity.label.text = id;
          }
          flightsCountRef.current = flightEntitiesById.size;
        } catch (e) {
          // Console log is sufficient for now.
          console.log("[Flights] Failed to sync flights:", e);
        }
      };

      // Initial sync + then periodic refresh.
      await syncFlights();
      intervalId = setInterval(syncFlights, refreshIntervalMs);

      // Expose sync to the UI toggle without reinitializing Cesium.
      syncFlightsRef.current = syncFlights;

      // -------------------------
      // Satellite layer
      // -------------------------
      // Future layers can follow this same pattern:
      // - Keep entities in `*EntitiesById` maps (no recreation each poll)
      // - Keep interpolation targets in `*MotionById` maps
      // - Poll in `sync*()` every 10s
      // - Animate in a decoupled `animate*()` rAF loop
      const satelliteEntitiesById = new Map();
      const satelliteMotionById = new Map();
      const satelliteMetaById = new Map();

      // Expose a visibility switch so the UI can hide/show satellites immediately.
      const setSatellitesVisibility = (visible) => {
        for (const entity of satelliteEntitiesById.values()) {
          try {
            entity.show = visible;
          } catch {
            // ignore
          }
        }
      };
      setSatellitesVisibilityRef.current = setSatellitesVisibility;
      setSatellitesVisibility(showSatellitesRef.current);

      const SATELLITE_POLL_INTERVAL_MS = refreshIntervalMs;
      const SATELLITE_ICON_SIZE_PX = 26;

      // Tiny satellite icon (white) encoded as an inline SVG data URL.
      const SATELLITE_ICON_URL =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="14" fill="none" stroke="white" stroke-width="3"/>
            <circle cx="32" cy="32" r="5" fill="white"/>
            <path d="M45 19L58 6" stroke="white" stroke-width="3" stroke-linecap="round"/>
            <path d="M19 45L6 58" stroke="white" stroke-width="3" stroke-linecap="round"/>
          </svg>
        `);

      // Higher altitude -> slightly smaller icon.
      const satelliteAltitudeToScale = (altMeters) =>
        Math.max(0.85, Math.min(1.15, 1.05 - altMeters / 2000000));

      const fetchSatellites = async () => {
        // Use our backend proxy so we keep external API concerns server-side.
        const res = await fetch("/api/satellites", { cache: "no-store" });
        if (!res.ok) return [];

        const data = await res.json();
        if (!Array.isArray(data)) return [];

        return data
          .map((s) => ({
            id: String(s?.id ?? "unknown"),
            name: typeof s?.name === "string" ? s.name : "",
            lat: Number(s?.lat),
            lon: Number(s?.lon),
            altitudeM: Number(s?.altitude),
            velocityKmh: Number(s?.velocity),
          }))
          .filter(
            (s) =>
              Number.isFinite(s.lat) &&
              Number.isFinite(s.lon) &&
              Number.isFinite(s.altitudeM) &&
              Number.isFinite(s.velocityKmh)
          );
      };

      const animateSatellitesInternal = (nowPerf) => {
        if (!showSatellitesRef.current) return;
        for (const [id, motion] of satelliteMotionById.entries()) {
          const entity = satelliteEntitiesById.get(id);
          if (!entity) continue;

          const denom = motion.t1 - motion.t0;
          const u = denom > 0 ? (nowPerf - motion.t0) / denom : 1;
          const t = Cesium.Math.clamp(u, 0, 1);

          Cesium.Cartesian3.lerp(
            motion.fromPos,
            motion.toPos,
            t,
            motion.scratchPos
          );
          entity.position = motion.scratchPos;

          const altNow =
            motion.fromAlt + (motion.toAlt - motion.fromAlt) * t;
          entity.billboard.scale = satelliteAltitudeToScale(altNow);
          entity.billboard.rotation = motion.headingRad ?? 0;
        }
      };

      const syncSatellites = async () => {
        if (cancelled || !viewer) return;

        try {
          const nowPerf = performance.now();

          // Cap entity count for performance.
          const results = (await fetchSatellites()).slice(0, 20);

          for (const sat of results) {
            const id = sat.id;

            const toPos = Cesium.Cartesian3.fromDegrees(
              sat.lon,
              sat.lat,
              sat.altitudeM
            );

            const toAlt = sat.altitudeM;
            const toScale = satelliteAltitudeToScale(toAlt);

            const existingEntity = satelliteEntitiesById.get(id);
            const existingMotion = satelliteMotionById.get(id);
            const prevMeta = satelliteMetaById.get(id);

            let fromPos = toPos;
            let fromAlt = toAlt;

            if (existingMotion) {
              const denom = existingMotion.t1 - existingMotion.t0;
              const u = denom > 0 ? (nowPerf - existingMotion.t0) / denom : 1;
              const t = Cesium.Math.clamp(u, 0, 1);

              const fromPosLerp = new Cesium.Cartesian3();
              Cesium.Cartesian3.lerp(
                existingMotion.fromPos,
                existingMotion.toPos,
                t,
                fromPosLerp
              );
              fromPos = fromPosLerp;
              fromAlt =
                existingMotion.fromAlt +
                (existingMotion.toAlt - existingMotion.fromAlt) * t;
            }

            // Estimate heading (rotation) from the last sample.
            let heading = 0;
            if (prevMeta) {
              heading = bearingRad(prevMeta.lastLat, prevMeta.lastLon, sat.lat, sat.lon);
            }

            // Create the entity if needed.
            if (!existingEntity) {
              const entity = viewer.entities.add({
                id,
                position: toPos,
                show: showSatellitesRef.current,
                billboard: {
                  image: SATELLITE_ICON_URL,
                  width: SATELLITE_ICON_SIZE_PX,
                  height: SATELLITE_ICON_SIZE_PX,
                  scale: toScale,
                  color: Cesium.Color.WHITE,
                  heightReference: Cesium.HeightReference.NONE,
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                  disableDepthTestDistance: 5000,
                  rotation: heading,
                },
                label: {
                  text: id,
                  font: "11px sans-serif",
                  fillColor: Cesium.Color.YELLOW,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 2,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new Cesium.Cartesian2(0, SATELLITE_ICON_SIZE_PX * 0.75),
                },
              });

              satelliteEntitiesById.set(id, entity);
            }

            // Update motion targets for interpolation.
            satelliteMotionById.set(id, {
              fromPos,
              toPos,
              fromAlt,
              toAlt,
              t0: nowPerf,
              t1: nowPerf + SATELLITE_POLL_INTERVAL_MS,
              headingRad: heading,
              scratchPos: new Cesium.Cartesian3(),
            });

            // Store metadata for click + future layers.
            satelliteMetaById.set(id, {
              name: sat.name,
              velocityKmh: sat.velocityKmh,
              lastTimePerf: nowPerf,
              lastLat: sat.lat,
              lastLon: sat.lon,
              lastAlt: toAlt,
            });
          }

          // If satellite layer is currently hidden, ensure entities stay hidden.
          setSatellitesVisibility(showSatellitesRef.current);
          satellitesCountRef.current = satelliteEntitiesById.size;
        } catch (e) {
          console.log("[Satellites] Failed to sync satellites:", e);
        }
      };

      // Initial sync + periodic refresh.
      await syncSatellites();
      satelliteIntervalId = setInterval(syncSatellites, SATELLITE_POLL_INTERVAL_MS);

      // -------------------------
      // Earthquake layer (static)
      // -------------------------
      const earthquakeEntitiesById = new Map();
      const earthquakeMetaById = new Map();
      const EARTHQUAKE_POLL_INTERVAL_MS = refreshIntervalMs;

      const setEarthquakesVisibility = (visible) => {
        for (const entity of earthquakeEntitiesById.values()) {
          try {
            entity.show = visible;
          } catch {
            // ignore
          }
        }
      };
      setEarthquakesVisibilityRef.current = setEarthquakesVisibility;
      setEarthquakesVisibility(showEarthquakesRef.current);

      const magnitudeToColor = (magnitude) => {
        if (magnitude >= 5) return Cesium.Color.RED;
        if (magnitude >= 3.5) return Cesium.Color.ORANGE;
        return Cesium.Color.YELLOW;
      };

      const magnitudeToSize = (magnitude) =>
        Math.max(5, Math.min(18, 4 + magnitude * 2));

      const fetchEarthquakes = async () => {
        const res = await fetch("/api/earthquakes", { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json();
        if (!Array.isArray(data)) return [];
        return data
          .map((e) => ({
            id: String(e?.id ?? ""),
            lat: Number(e?.lat),
            lon: Number(e?.lon),
            magnitude: Number(e?.magnitude),
            place: typeof e?.place === "string" ? e.place : "",
            time: Number(e?.time),
          }))
          .filter(
            (e) =>
              e.id &&
              Number.isFinite(e.lat) &&
              Number.isFinite(e.lon) &&
              Number.isFinite(e.magnitude) &&
              Number.isFinite(e.time)
          );
      };

      const syncEarthquakes = async () => {
        if (cancelled || !viewer) return;

        try {
          const earthquakesRaw = await fetchEarthquakes();
          // Cap entity count (recent first) for performance.
          const earthquakes = Array.isArray(earthquakesRaw)
            ? earthquakesRaw
                .slice()
                .sort((a, b) => b.time - a.time)
                .slice(0, 50)
            : [];

          const incomingKeys = new Set(earthquakes.map((e) => `eq-${e.id}`));

          // Remove earthquakes that disappeared from the feed.
          for (const [entityKey, entity] of earthquakeEntitiesById.entries()) {
            if (!incomingKeys.has(entityKey)) {
              try {
                viewer.entities.remove(entity);
              } catch {
                // ignore
              }
              earthquakeEntitiesById.delete(entityKey);
              earthquakeMetaById.delete(entityKey);
            }
          }

          for (const eq of earthquakes) {
            const entityKey = `eq-${eq.id}`;

            const position = Cesium.Cartesian3.fromDegrees(eq.lon, eq.lat, 0);
            const pixelSize = magnitudeToSize(eq.magnitude);
            const color = magnitudeToColor(eq.magnitude);

            const existingEntity = earthquakeEntitiesById.get(entityKey);
            if (!existingEntity) {
              const entity = viewer.entities.add({
                id: entityKey,
                position,
                show: showEarthquakesRef.current,
                point: {
                  pixelSize,
                  color,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 1,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: 5000,
                },
              });
              earthquakeEntitiesById.set(entityKey, entity);
            } else {
              existingEntity.position = position;
              existingEntity.point.pixelSize = pixelSize;
              existingEntity.point.color = color;
              existingEntity.show = showEarthquakesRef.current;
            }

            earthquakeMetaById.set(entityKey, {
              id: eq.id,
              magnitude: eq.magnitude,
              place: eq.place,
              time: eq.time,
            });
          }

          // Respect layer visibility after update.
          setEarthquakesVisibility(showEarthquakesRef.current);
          earthquakesCountRef.current = earthquakeEntitiesById.size;
        } catch (e) {
          console.log("[Earthquakes] Failed to sync earthquakes:", e);
        }
      };

      await syncEarthquakes();
      earthquakeIntervalId = setInterval(syncEarthquakes, EARTHQUAKE_POLL_INTERVAL_MS);

      // -------------------------
      // Traffic layer (simulated cars on OSM roads)
      // -------------------------
      const trafficEntitiesById = new Map();
      const trafficMotionById = new Map();
      const trafficMetaById = new Map();

      // Small car icon (white) as inline SVG data URL (billboard).
      const CAR_ICON_URL =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <path fill="white" d="M14 36l4-14c1-4 4-6 8-6h12c4 0 7 2 8 6l4 14v12c0 2-2 4-4 4h-2c-2 0-4-2-4-4v-2H22v2c0 2-2 4-4 4h-2c-2 0-4-2-4-4V36z"/>
            <path fill="white" opacity="0.25" d="M22 20h20c2 0 4 1 4 3l2 7H20l2-7c0-2 2-3 4-3z"/>
            <circle cx="22" cy="40" r="4" fill="black"/>
            <circle cx="42" cy="40" r="4" fill="black"/>
          </svg>
        `);

      const setTrafficVisibility = (visible) => {
        for (const entity of trafficEntitiesById.values()) {
          try {
            entity.show = visible;
          } catch {
            // ignore
          }
        }
      };
      setTrafficVisibilityRef.current = setTrafficVisibility;
      setTrafficVisibility(showTrafficRef.current);

      const fetchTrafficRoads = async () => {
        const res = await fetch("/api/traffic", { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json();
        if (!Array.isArray(data)) return [];

        return data
          .map((road) => ({
            id: String(road?.id ?? ""),
            path: Array.isArray(road?.path) ? road.path : [],
          }))
          .filter(
            (road) =>
              road.id &&
              road.path.length >= 2 &&
              road.path.every(
                (p) =>
                  Array.isArray(p) &&
                  p.length === 2 &&
                  Number.isFinite(Number(p[0])) &&
                  Number.isFinite(Number(p[1]))
              )
          );
      };

      const computePathMotion = (pathLonLat) => {
        const cartesianPath = pathLonLat.map(([lon, lat]) =>
          Cesium.Cartesian3.fromDegrees(Number(lon), Number(lat), 0)
        );

        const segmentLengths = [];
        let totalLength = 0;
        for (let i = 0; i < cartesianPath.length - 1; i += 1) {
          const segLen = Cesium.Cartesian3.distance(cartesianPath[i], cartesianPath[i + 1]);
          segmentLengths.push(segLen);
          totalLength += segLen;
        }

        return { cartesianPath, segmentLengths, totalLength };
      };

      const samplePositionOnPath = (motion, distanceAlongPath, result) => {
        const { cartesianPath, segmentLengths, totalLength } = motion;
        if (!cartesianPath.length) return result;
        if (cartesianPath.length === 1 || totalLength <= 0) {
          return Cesium.Cartesian3.clone(cartesianPath[0], result);
        }

        let d = distanceAlongPath % totalLength;
        if (d < 0) d += totalLength;

        for (let i = 0; i < segmentLengths.length; i += 1) {
          const segLen = segmentLengths[i];
          if (d <= segLen || i === segmentLengths.length - 1) {
            const t = segLen > 0 ? d / segLen : 0;
            return Cesium.Cartesian3.lerp(cartesianPath[i], cartesianPath[i + 1], t, result);
          }
          d -= segLen;
        }

        return Cesium.Cartesian3.clone(cartesianPath[cartesianPath.length - 1], result);
      };

      const carsPerRoad = (roadId) => {
        // Deterministic 1-3 cars per road.
        let h = 0;
        for (let i = 0; i < roadId.length; i += 1) {
          h = (h * 31 + roadId.charCodeAt(i)) % 9973;
        }
        return (h % 3) + 1;
      };

      const TRAFFIC_POLL_INTERVAL_MS = 30000;
      const MAX_ROADS_FOR_SIM = 30;

      const syncTraffic = async () => {
        if (cancelled || !viewer) return;

        try {
          const roads = await fetchTrafficRoads();
          const selectedRoads = roads.slice(0, MAX_ROADS_FOR_SIM);

          const activeCarIds = new Set();

          for (const road of selectedRoads) {
            const pathLonLat = road.path;
            const pathData = computePathMotion(pathLonLat);
            if (pathData.totalLength <= 1) continue;

            const carCount = carsPerRoad(road.id);

            for (let carIdx = 0; carIdx < carCount; carIdx += 1) {
              const carId = `traffic-${road.id}-${carIdx}`;
              activeCarIds.add(carId);

              const existingEntity = trafficEntitiesById.get(carId);
              const existingMotion = trafficMotionById.get(carId);

              const speedMps = 8 + carIdx * 3; // small variation per road
              const initialDistance = (carIdx / carCount) * pathData.totalLength;

              const newMotion = {
                roadId: road.id,
                cartesianPath: pathData.cartesianPath,
                segmentLengths: pathData.segmentLengths,
                totalLength: pathData.totalLength,
                speedMps,
                distance: existingMotion?.distance ?? initialDistance,
                scratchPos: existingMotion?.scratchPos ?? new Cesium.Cartesian3(),
              };

              if (!existingEntity) {
                const startPos = samplePositionOnPath(
                  newMotion,
                  newMotion.distance,
                  new Cesium.Cartesian3()
                );

                // Slight scaling based on speed.
                const scale = Math.max(0.8, Math.min(1.3, 0.9 + speedMps / 30));

                const entity = viewer.entities.add({
                  id: carId,
                  position: startPos,
                  show: showTrafficRef.current,
                  billboard: {
                    image: CAR_ICON_URL,
                    width: 20,
                    height: 20,
                    scale,
                    color: Cesium.Color.WHITE,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    disableDepthTestDistance: 5000,
                  },
                });
                trafficEntitiesById.set(carId, entity);
              } else {
                existingEntity.show = showTrafficRef.current;
                // Keep a consistent scale if speed changes later.
                if (existingEntity.billboard) {
                  existingEntity.billboard.scale = Math.max(
                    0.8,
                    Math.min(1.3, 0.9 + speedMps / 30)
                  );
                }
              }

              trafficMotionById.set(carId, newMotion);

              trafficMetaById.set(carId, {
                vehicleId: carId,
                roadId: road.id,
                speedMps,
              });
            }
          }

          // Remove cars that no longer belong to active roads.
          for (const [carId, entity] of trafficEntitiesById.entries()) {
            if (!activeCarIds.has(carId)) {
              try {
                viewer.entities.remove(entity);
              } catch {
                // ignore
              }
              trafficEntitiesById.delete(carId);
              trafficMotionById.delete(carId);
              trafficMetaById.delete(carId);
            }
          }

          setTrafficVisibility(showTrafficRef.current);
          trafficCarsCountRef.current = trafficEntitiesById.size;
        } catch (e) {
          console.log("[Traffic] Failed to sync traffic roads:", e);
        }
      };

      const animateTrafficInternal = (dtSec) => {
        if (!showTrafficRef.current) return;
        for (const [carId, motion] of trafficMotionById.entries()) {
          const entity = trafficEntitiesById.get(carId);
          if (!entity) continue;

          motion.distance += motion.speedMps * dtSec;
          samplePositionOnPath(motion, motion.distance, motion.scratchPos);
          entity.position = motion.scratchPos;

          // Rotate car to face direction of motion (approx from a small forward sample).
          if (entity.billboard) {
            const aheadPos = new Cesium.Cartesian3();
            samplePositionOnPath(motion, motion.distance + 5, aheadPos);
            const heading = Cesium.Math.headingPitchRollToFixedFrame
              ? 0
              : 0;
            // Simpler: derive heading via ENU frame.
            // Compute heading from current->ahead in local tangent plane.
            try {
              const enu = Cesium.Transforms.eastNorthUpToFixedFrame(motion.scratchPos);
              const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
              const localAhead = Cesium.Matrix4.multiplyByPoint(inv, aheadPos, new Cesium.Cartesian3());
              entity.billboard.rotation = Math.atan2(localAhead.x, localAhead.y);
            } catch {
              // ignore rotation issues
            }
          }
        }
      };

      await syncTraffic();
      trafficIntervalId = setInterval(syncTraffic, TRAFFIC_POLL_INTERVAL_MS);

      // -------------------------
      // Global animation loop
      // -------------------------
      // Single rAF for all layers with optional ~30 FPS throttling.
      const targetFrameMs = 33; // ~30fps
      let lastFrameTime = 0;
      let lastTrafficTime = 0;

      const animateAll = (time) => {
        if (cancelled || !viewer) return;

        // Schedule next frame first to keep animation stable even if work below throws.
        animationFrameId = requestAnimationFrame(animateAll);

        // FPS calculation (lightweight): update approx once per second.
        fpsCalcRef.current.frames += 1;
        if (!fpsCalcRef.current.lastSampleMs) fpsCalcRef.current.lastSampleMs = time;
        const elapsedMs = time - fpsCalcRef.current.lastSampleMs;
        if (elapsedMs >= 1000) {
          const fps = Math.round((fpsCalcRef.current.frames * 1000) / elapsedMs);
          fpsCalcRef.current.fps = fps;
          fpsRef.current = fps;
          fpsCalcRef.current.frames = 0;
          fpsCalcRef.current.lastSampleMs = time;
        }

        if (lastFrameTime && time - lastFrameTime < targetFrameMs) return;
        lastFrameTime = time;

        // Flights + satellites use "time" (ms) for interpolation between polls.
        animateFlightsInternal(time);
        animateSatellitesInternal(time);

        // Traffic needs dt.
        const dtSec = Math.min(0.1, Math.max(0, (time - (lastTrafficTime || time)) / 1000));
        lastTrafficTime = time;
        animateTrafficInternal(dtSec);
      };

      animationFrameId = requestAnimationFrame(animateAll);

      // Click-to-inspect flight OR satellite OR earthquake details.
      // We read current interpolated altitude from motion at click time.
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
      handler.setInputAction((movement) => {
        try {
          const picked = viewer.scene.pick(movement.position);
          const entity = picked?.id;
          const id = entity?.id;
          if (!id) {
            setFlightDetails(null);
            setSatelliteDetails(null);
            setEarthquakeDetails(null);
            setTrafficDetails(null);
            return;
          }

          // Priority: if it's a flight, treat it as a flight.
          const flightMotion = flightMotionById.get(id);
          const flightMeta = flightMetaById.get(id);
          if (flightMotion && flightMeta) {
            const nowPerf = performance.now();
            const denom = flightMotion.t1 - flightMotion.t0;
            const u = denom > 0 ? (nowPerf - flightMotion.t0) / denom : 1;
            const t = Cesium.Math.clamp(u, 0, 1);

            const altNow =
              flightMotion.fromAlt +
              (flightMotion.toAlt - flightMotion.fromAlt) * t;
            const speedMps = flightMeta.speedMps ?? 0;
            const speedKmh = speedMps * 3.6;

            setFlightDetails({
              id,
              altitudeM: altNow,
              speedKmh,
            });
            setSatelliteDetails(null);
            setEarthquakeDetails(null);
            setTrafficDetails(null);
            return;
          }

          // Otherwise, if it's a satellite, treat it as a satellite.
          const satMotion = satelliteMotionById.get(id);
          const satMeta = satelliteMetaById.get(id);
          if (satMotion && satMeta) {
            const nowPerf = performance.now();
            const denom = satMotion.t1 - satMotion.t0;
            const u = denom > 0 ? (nowPerf - satMotion.t0) / denom : 1;
            const t = Cesium.Math.clamp(u, 0, 1);

            const altNow =
              satMotion.fromAlt + (satMotion.toAlt - satMotion.fromAlt) * t;

            setSatelliteDetails({
              id,
              name: satMeta.name,
              altitudeM: altNow,
              velocityKmh: satMeta.velocityKmh ?? 0,
            });
            setFlightDetails(null);
            setEarthquakeDetails(null);
            setTrafficDetails(null);
            return;
          }

          // Otherwise, if it's an earthquake, treat it as an earthquake.
          const eqMeta = earthquakeMetaById.get(id);
          if (eqMeta) {
            setEarthquakeDetails({
              id: eqMeta.id,
              magnitude: eqMeta.magnitude,
              place: eqMeta.place,
              time: eqMeta.time,
            });
            setFlightDetails(null);
            setSatelliteDetails(null);
            setTrafficDetails(null);
            return;
          }

          // Otherwise, if it's traffic, treat it as traffic.
          if (typeof id === "string" && id.startsWith("traffic-")) {
            const meta = trafficMetaById.get(id);
            const motion = trafficMotionById.get(id);
            if (meta && motion) {
              const progress =
                motion.totalLength > 0
                  ? (Math.max(0, motion.distance % motion.totalLength) /
                      motion.totalLength) *
                    100
                  : 0;

              setTrafficDetails({
                vehicleId: meta.vehicleId,
                roadId: meta.roadId,
                speedMps: meta.speedMps,
                speedKmh: meta.speedMps * 3.6,
                progressPct: progress,
              });
              setFlightDetails(null);
              setSatelliteDetails(null);
              setEarthquakeDetails(null);
              return;
            }
          }

          setFlightDetails(null);
          setSatelliteDetails(null);
          setEarthquakeDetails(null);
          setTrafficDetails(null);
        } catch {
          // ignore click failures
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      flightClickHandler = handler;
    };

    init().catch((err) => {
      // Cesium sometimes throws non-Error values; normalize to show useful details.
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "";
      const stack = err instanceof Error ? err.stack : "";
      console.error("[Cesium] Initialization failed:", { message, stack, err });
    });

    return () => {
      cancelled = true;
      // Best-effort cleanup of flight refresh interval (if created).
      try {
        if (intervalId) clearInterval(intervalId);
      } catch {
        // ignore
      }

      try {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
      } catch {
        // ignore
      }

      try {
        if (satelliteIntervalId) clearInterval(satelliteIntervalId);
      } catch {
        // ignore
      }

      try {
        if (earthquakeIntervalId) clearInterval(earthquakeIntervalId);
      } catch {
        // ignore
      }

      try {
        if (trafficIntervalId) clearInterval(trafficIntervalId);
      } catch {
        // ignore
      }

      try {
        flightClickHandler?.destroy();
      } catch {
        // ignore
      }

      try {
        clearFlightsRef.current?.();
      } catch {
        // ignore
      }

      if (viewer) {
        try {
          if (!viewer.isDestroyed()) viewer.destroy();
        } catch {
          // Best-effort cleanup on unmount.
        }
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div ref={containerRef} className="cesiumRoot" />

      {/* Layers panel */}
      <div
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          zIndex: 10,
          background: "rgba(0, 0, 0, 0.6)",
          color: "white",
          padding: "12px",
          borderRadius: 10,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          fontFamily: "Arial, Helvetica, sans-serif",
          userSelect: "none",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Layers</div>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <input
            type="checkbox"
            checked={showFlights}
            onChange={(e) => setShowFlights(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Flights</span>
        </label>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <input
            type="checkbox"
            checked={showSatellites}
            onChange={(e) => setShowSatellites(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Satellites</span>
        </label>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <input
            type="checkbox"
            checked={showEarthquakes}
            onChange={(e) => setShowEarthquakes(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Earthquakes</span>
        </label>

        {/* Earthquake legend */}
        <div style={{ padding: "6px 8px 2px 8px", fontSize: 12, opacity: 0.9 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Quake legend</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: "#facc15", display: "inline-block" }} />
            <span>Mag &lt; 4</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: "#fb923c", display: "inline-block" }} />
            <span>Mag 4–6</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: "#ef4444", display: "inline-block" }} />
            <span>Mag &gt; 6</span>
          </div>
        </div>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <input
            type="checkbox"
            checked={showTraffic}
            onChange={(e) => setShowTraffic(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Traffic</span>
        </label>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "6px 8px",
            borderRadius: 8,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            style={{ accentColor: "#a78bfa" }}
          />
          <span>Show Debug</span>
        </label>
      </div>

      {/* Debug stats panel */}
      {showDebug && (
        <div
          style={{
            position: "absolute",
            bottom: 20,
            left: 20,
            zIndex: 10,
            background: "rgba(0, 0, 0, 0.6)",
            color: "white",
            padding: "10px 12px",
            borderRadius: 8,
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 12,
            lineHeight: "18px",
            userSelect: "none",
            minWidth: 190,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Debug</div>
          <div>
            <b>FPS:</b> {debugStats.fps}
          </div>
          <div>
            <b>Flights:</b> {debugStats.flights}
          </div>
          <div>
            <b>Satellites:</b> {debugStats.satellites}
          </div>
          <div>
            <b>Earthquakes:</b> {debugStats.earthquakes}
          </div>
          <div>
            <b>Traffic cars:</b> {debugStats.trafficCars}
          </div>
        </div>
      )}

      {/* Flight details panel (click-to-inspect) */}
      {flightDetails && (
        <div
          style={{
            position: "absolute",
            top: 20,
            left: 20,
            zIndex: 10,
            background: "rgba(0, 0, 0, 0.6)",
            color: "white",
            padding: "12px",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            fontFamily: "Arial, Helvetica, sans-serif",
            userSelect: "none",
            minWidth: 200,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Flight</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>ID:</b> {flightDetails.id}
          </div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Altitude:</b> {Math.round(flightDetails.altitudeM)} m
          </div>
          <div style={{ fontSize: 13 }}>
            <b>Speed:</b> {Math.round(flightDetails.speedKmh)} km/h
          </div>
        </div>
      )}

      {/* Satellite details panel (click-to-inspect) */}
      {satelliteDetails && (
        <div
          style={{
            position: "absolute",
            top: 20,
            left: 240,
            zIndex: 10,
            background: "rgba(0, 0, 0, 0.6)",
            color: "white",
            padding: "12px",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            fontFamily: "Arial, Helvetica, sans-serif",
            userSelect: "none",
            minWidth: 220,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Satellite</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>ID:</b> {satelliteDetails.id}
          </div>
          {satelliteDetails.name && (
            <div style={{ fontSize: 13, marginBottom: 4 }}>
              <b>Name:</b> {satelliteDetails.name}
            </div>
          )}
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Altitude:</b> {Math.round(satelliteDetails.altitudeM)} m
          </div>
          <div style={{ fontSize: 13 }}>
            <b>Velocity:</b> {Math.round(satelliteDetails.velocityKmh)} km/h
          </div>
        </div>
      )}

      {/* Earthquake details panel (click-to-inspect) */}
      {earthquakeDetails && (
        <div
          style={{
            position: "absolute",
            top: 250,
            left: 20,
            zIndex: 10,
            background: "rgba(0, 0, 0, 0.6)",
            color: "white",
            padding: "12px",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            fontFamily: "Arial, Helvetica, sans-serif",
            userSelect: "none",
            minWidth: 280,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Earthquake</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Magnitude:</b> {earthquakeDetails.magnitude.toFixed(1)}
          </div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Location:</b> {earthquakeDetails.place || "Unknown"}
          </div>
          <div style={{ fontSize: 13 }}>
            <b>Time:</b> {new Date(earthquakeDetails.time).toLocaleString()}
          </div>
        </div>
      )}

      {/* Traffic details panel (click-to-inspect) */}
      {trafficDetails && (
        <div
          style={{
            position: "absolute",
            top: 250,
            left: 320,
            zIndex: 10,
            background: "rgba(0, 0, 0, 0.6)",
            color: "white",
            padding: "12px",
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            fontFamily: "Arial, Helvetica, sans-serif",
            userSelect: "none",
            minWidth: 260,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Traffic</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Vehicle ID:</b> {trafficDetails.vehicleId}
          </div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Road ID:</b> {trafficDetails.roadId}
          </div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <b>Speed:</b> {Math.round(trafficDetails.speedMps)} m/s (
            {Math.round(trafficDetails.speedKmh)} km/h)
          </div>
          <div style={{ fontSize: 13 }}>
            <b>Progress:</b> {trafficDetails.progressPct.toFixed(1)}%
          </div>
        </div>
      )}
    </>
  );
}

