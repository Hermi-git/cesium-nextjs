import CesiumViewer from "../components/CesiumViewer";

export default function Page() {
  // Read env on the server and pass to the client component.
  // This avoids cases where Turbopack doesn't inline env vars into the browser bundle.
  const ionToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN || "";

  return <CesiumViewer ionToken={ionToken} />;
}

