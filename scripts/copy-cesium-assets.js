/**
 * Copies CesiumJS "Build/Cesium" static assets from `node_modules`
 * into Next.js `public/cesium`.
 *
 * Why this is needed:
 * - Cesium loads Workers/Assets/Widgets/ThirdParty at runtime via URLs.
 * - Using `public/` ensures those assets are served by Next.js without a CDN.
 *
 * Required folders (per your request):
 * - Workers
 * - Assets
 * - Widgets
 * - ThirdParty
 */

const fs = require("node:fs");
const path = require("node:path");

function copyEntry({ src, dest }) {
  // `fs.cpSync` handles both files and directories; for files it behaves like a normal copy.
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

const projectRoot = path.join(__dirname, "..");
const cesiumBuildDir = path.join(
  projectRoot,
  "node_modules",
  "cesium",
  "Build",
  "Cesium"
);
const publicCesiumDir = path.join(projectRoot, "public", "cesium");

// Copy the required Cesium runtime asset directories/files.
const entriesToCopy = [
  "Workers",
  "Assets",
  "Widgets",
  "ThirdParty",
  "Cesium.js",
];

ensureDir(publicCesiumDir);

for (const entry of entriesToCopy) {
  const srcPath = path.join(cesiumBuildDir, entry);
  const destPath = path.join(publicCesiumDir, entry);

  if (!fs.existsSync(srcPath)) {
    // Hard-fail so the developer notices missing runtime assets.
    throw new Error(`Cesium asset entry not found: ${srcPath}`);
  }

  copyEntry({ src: srcPath, dest: destPath });
}

console.log("[Cesium] Copied static assets to public/cesium");

