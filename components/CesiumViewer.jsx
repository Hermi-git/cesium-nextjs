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

  useEffect(() => {
    if (!containerRef.current) return;

    let viewer = null;
    let cancelled = false;
    let intervalId = null;
    let animationFrameId = null;
    let satelliteIntervalId = null;
    let satelliteAnimationFrameId = null;
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

      // Motion interpolation animation loop (smooth movement).
      // Uses linear interpolation between successive poll samples.
      // animationFrameId and flightClickHandler are owned by the effect scope.
      const animateFlights = () => {
        if (cancelled || !viewer) return;

        // If flights are hidden, don't animate positions (entities are removed).
        if (!showFlightsRef.current) {
          animationFrameId = requestAnimationFrame(animateFlights);
          return;
        }

        const nowPerf = performance.now();

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

        animationFrameId = requestAnimationFrame(animateFlights);
      };

      const syncFlights = async () => {
        if (cancelled || !viewer) return;
        if (!showFlightsRef.current) return;

        try {
          const flights = await fetchFlights();
          if (cancelled || !viewer) return;

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
        } catch (e) {
          // Console log is sufficient for now.
          console.log("[Flights] Failed to sync flights:", e);
        }
      };

      // Initial sync + then periodic refresh.
      await syncFlights();
      intervalId = setInterval(syncFlights, refreshIntervalMs);

      // Start the animation loop.
      animationFrameId = requestAnimationFrame(animateFlights);

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

      // Animation loop for satellites (decoupled from polling).
      const animateSatellites = () => {
        if (cancelled || !viewer) return;

        // Keep animation off when hidden (but polling continues).
        if (!showSatellitesRef.current) {
          satelliteAnimationFrameId = requestAnimationFrame(animateSatellites);
          return;
        }

        const nowPerf = performance.now();

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

        satelliteAnimationFrameId = requestAnimationFrame(animateSatellites);
      };

      const syncSatellites = async () => {
        if (cancelled || !viewer) return;

        try {
          const nowPerf = performance.now();

          const results = await fetchSatellites();

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
        } catch (e) {
          console.log("[Satellites] Failed to sync satellites:", e);
        }
      };

      // Initial sync + periodic refresh.
      await syncSatellites();
      satelliteIntervalId = setInterval(syncSatellites, SATELLITE_POLL_INTERVAL_MS);
      satelliteAnimationFrameId = requestAnimationFrame(animateSatellites);

      // Click-to-inspect flight OR satellite details.
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
            return;
          }

          setFlightDetails(null);
          setSatelliteDetails(null);
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
        if (satelliteAnimationFrameId) cancelAnimationFrame(satelliteAnimationFrameId);
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
          padding: "12px 14px",
          borderRadius: 8,
          fontFamily: "Arial, Helvetica, sans-serif",
          userSelect: "none",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Layers</div>

        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={showFlights}
            onChange={(e) => setShowFlights(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Flights</span>
        </label>

        <div style={{ height: 10 }} />

        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={showSatellites}
            onChange={(e) => setShowSatellites(e.target.checked)}
            style={{ accentColor: "#22d3ee" }}
          />
          <span>Show Satellites</span>
        </label>
      </div>

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
            padding: "12px 14px",
            borderRadius: 8,
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
            padding: "12px 14px",
            borderRadius: 8,
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
    </>
  );
}

