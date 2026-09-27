---
description: How to extract real-world terrain heightmaps and satellite images
---

# Extracting Real-World Terrain

To use the "Real Terrain" feature in the app, you need two images for your desired location:
1.  **Heightmap**: A greyscale image where brighter = higher elevation.
2.  **Satellite Map**: A color image for the texture.

## Step 1: Get the Heightmap
1.  Go to **[Tangrams Heightmapper](https://tangrams.github.io/heightmapper/)**.
2.  Uncheck "Map Labels" and "Map Lines" in the sidebar (if any) to get a clean image.
3.  Navigate to your target area (e.g., Dubai, Himalayas).
4.  Zoom in to the level of detail you want.
    *   *Tip*: For a window view, a scale of approx 50km-100km wide is good.
5.  Click **Export** to download the `heightmap.png`.

## Step 2: Get the Satellite Map
1.  Go to a map provider like **Google Maps** (Satellite View) or **Mapbox Studio**.
2.  Try to frame the **exact same area** as your heightmap.
3.  Take a screenshot or export the image.
4.  Save as `satellite.png` (or `.jpg`).

## Step 3: Add to App
1.  Move the files to the app's assets folder:
    ```bash
    cp ~/Downloads/heightmap.png static/assets/heightmap.png
    cp ~/Downloads/satellite.png static/assets/satellite.png
    ```
2.  Update `src/lib/layers/3d/Ground.svelte`:
    ```typescript
    const heightMap = textureLoader.load('/assets/heightmap.png');
    const satelliteMap = textureLoader.load('/assets/satellite.png');
    ```
